/**
 * 码头机械设备监控看板
 * ============================================================
 * State.devices  — 全量设备, 按 id merge
 * State.ships    — 船舶列表
 * State.shipProgPct — 船舶作业进度历史百分比（本地缓存）
 * State.shipProgNum — 船舶作业进度历史箱量（全量，后端 GET）
 * 
 * SSE → _route() → State.merge() → render()
 */

/** 转义 HTML 特殊字符 */
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** done/plan → 0-100 百分比 */
const toPct = (done, plan) => (plan ? Math.min(100, Math.round((done / plan) * 100)) : 0);


/* ============================================================
   Config - 处理静态配置文件（web/static/config.json）
   ============================================================ */

const Config = {
  data: null,
  async load() {
    try {
      const r = await fetch('config.json', { cache: 'no-cache' });
      this.data = await r.json();
    } catch { this.data = null; }
  },
  ids(type) {
    return this.data?.devices?.[type] ?? null;
  },
};

/** 按配置过滤设备；ids 为 null 时返回全部 */
function filterByConfig(devices, type) {
  const ids = Config.ids(type);
  return ids ? devices.filter(d => ids.includes(d.id)) : devices;
}


/* ============================================================
   State
   ============================================================ */

const State = {
  devices: {},
  ships: [],
  shipProgPct: {},          // { [id]: [{ t, iPct, ePct }] }      百分比历史，用于 sparkline
  shipProgNum: {},          // { [id]: [{ t, i_done, e_done }] }  详细箱量历史，用于 shipDetail
  shipProgNumLoaded: false, // 是否已 GET 详细箱量历史
  statsMode: 'shift',       // 'day'=当日 / 'shift'=当班（默认当班，由后端 stats_mode 推送更新）

  // 船舶进度历史配置
  get CFG() {
    return Config.data?.ship_history ?? {};
  },

  _initShipProgPct() {
    try { this.shipProgPct = JSON.parse(localStorage.getItem('shipProgPct')) || {}; }
    catch { this.shipProgPct = {}; }
  },

  _saveShipProgPct() {
    const cutoff = Date.now() - this.CFG.ttlHours * 3600 * 1000;
    for (const [id, h] of Object.entries(this.shipProgPct)) {
      const last = h[h.length - 1];
      if (!last || last.t < cutoff) { delete this.shipProgPct[id]; continue; }
      if (h.length > this.CFG.maxPoints) h.splice(0, h.length - this.CFG.maxPoints);
    }
    const ids = Object.keys(this.shipProgPct)
      .sort((a, b) => {
        const ha = this.shipProgPct[a], hb = this.shipProgPct[b];
        return ha[ha.length - 1].t - hb[hb.length - 1].t;
      });
    for (const id of ids.slice(0, Math.max(0, ids.length - this.CFG.maxShips))) delete this.shipProgPct[id];
    try {
      localStorage.setItem('shipProgPct', JSON.stringify(this.shipProgPct));
    } catch (e) { /* localStorage 满/被禁用时不致命，忽略 */ }
  },

  /** 取船舶进度历史的渲染采样：间隔取点 + 最多 renderPoints 个 */
  sampleShipProgPct(id) {
    const h = this.shipProgPct[id];
    if (!h || h.length < 2) return [];
    const { renderInterval, renderPoints } = this.CFG;
    const out = [];
    for (let i = 0; i < h.length; i += renderInterval) out.push(h[i]);
    return out.slice(-renderPoints);
  },

  merge(list) {
    for (const d of list || []) {
      if (!d.id) continue;
      if (!this.devices[d.id]) this.devices[d.id] = {};
      Object.assign(this.devices[d.id], d);
    }
  },

  /** @param {'1'|'2'|'3'} prefix */
  getByType(prefix) {
    return Object.values(this.devices)
      .filter(d => d.id && d.id[0] === prefix)
      .sort((a, b) => a.id.localeCompare(b.id));
  },

  /** 统计在线设备数 */
  countOnline(list) {
    return list.filter(d => d.status === '1').length;
  },

  /** 合并船舶作业进度 */
  mergeShipProgress(list) {
    const map = new Map((this.ships || []).map(s => [s.id, s]));
    for (const p of list || []) {
      const ship = map.get(p.id);
      if (ship) Object.assign(ship, p);
    }
  },

  /** 追加记录船舶进度百分比点 */
  pushShipProgPct(list, ts) {
    const t = Number(ts) || Date.now();
    for (const p of list || []) {
      if (p.id == null) continue;
      if (!(Number(p.i_plan_num) || 0) && !(Number(p.e_plan_num) || 0)) continue;
      const h = (this.shipProgPct[p.id] ||= []);
      h.push({
        t,
        iPct: toPct(p.i_done_num ?? 0, p.i_plan_num ?? 0),
        ePct: toPct(p.e_done_num ?? 0, p.e_plan_num ?? 0),
      });
    }
    this._saveShipProgPct();
  },

  /** GET 获取全部船舶作业进度历史 */
  setShipProgNum(ships) {
    const out = {};
    for (const [id, pts] of Object.entries(ships || {})) {
      out[id] = (pts || [])
        .filter(p => p.t != null)
        .map(p => ({ t: p.t, i_done: Number(p.i_done || 0), e_done: Number(p.e_done || 0) }))
        .sort((a, b) => a.t - b.t);
    }
    this.shipProgNum = out;
    this.shipProgNumLoaded = true;
  },

  /** 追加记录船舶作业进度箱量点 */
  pushShipProgNum(list, ts) {
    const t = Number(ts) || Date.now();
    for (const p of list || []) {
      const id = p.id;
      if (id == null) continue;
      const arr = (this.shipProgNum[id] ||= []);
      const i = Number(p.i_done_num || 0), e = Number(p.e_done_num || 0);
      const last = arr[arr.length - 1];
      if (last && Math.abs(last.t - t) < 60_000) { last.i_done = i; last.e_done = e; }
      else arr.push({ t, i_done: i, e_done: e });
    }
  },
};


/* ============================================================
   Header - 日期/时间/连接状态
   ============================================================ */

const Header = {
  init() {
    this.el = {
      date:   document.getElementById('date-text'),
      time:   document.getElementById('time-text'),
      conn:   document.getElementById('conn-status'),
    };
    this._tick();
    setInterval(() => this._tick(), 1000);
  },

  /** 连接状态 */
  setConnected(on) {
    this.el.conn.textContent = on ? '已连接' : '未连接';
    this.el.conn.classList.toggle('connected', on);
  },

  _tick() {
    const now = new Date();
    this.el.date.textContent = now.toLocaleDateString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
    this.el.time.textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
  },
};


/* ============================================================
   Ships
   ============================================================ */

const Ships = {
  MAX_SHIPS: 4,
  BERTH_LABELS: { '207B': '207', '208B': '208' },

  init() {
    this.el = document.getElementById('ship-info');
  },

  render(list) {
    const ships = list || State.ships;

    // 状态 → 过滤预报船 → 排序 → 截取
    const showForecast = Config.data?.show_forecast_ships !== false;
    const topN = [...ships]
      .map(s => ({ ...s, _st: this._shipState(s) }))
      .filter(s => showForecast || s._st.state !== 'wait')
      .sort(this._sortShip.bind(this))
      .slice(0, this.MAX_SHIPS);

    if (!topN.length) {
      this.el.innerHTML = '<span class="ship-placeholder">暂无船舶</span>';
      return;
    }

    const cards = topN.map(s => {
      const esc = escapeHtml;
      const st = s._st;
      const p = this._progress(s);
      const name   = s.ship_name || s.id || '--';
      const voyage = s.voyage || '';
      const berth  = this._berthLabel(s.berth);
      const title  = `${name} ${voyage}`.trim(); 

      const progress = (p.iPlan > 0 || p.ePlan > 0)
        ? `<div class="sc-progress">
             <div class="scp-row">
               <div class="scp-line">
                 <span class="scp-label">卸</span>
                 <span class="scp-num"><b>${p.iDone}</b>/${p.iPlan}</span>
                 <span class="scp-pct">${this._pct(p.iDone, p.iPlan)}</span>
               </div>
               <div class="bar"><div class="bar-fill bar-i" data-pct="${toPct(p.iDone, p.iPlan)}"></div></div>
             </div>
             <div class="scp-row">
               <div class="scp-line">
                 <span class="scp-label">装</span>
                 <span class="scp-num"><b>${p.eDone}</b>/${p.ePlan}</span>
                 <span class="scp-pct">${this._pct(p.eDone, p.ePlan)}</span>
               </div>
               <div class="bar"><div class="bar-fill bar-e" data-pct="${toPct(p.eDone, p.ePlan)}"></div></div>
             </div>
           </div>`
        : '';

      const spark = this._sparkline(s);
      const progressBlock = (progress || spark)
        ? `<div class="sc-progress-wrap">${progress}${spark}</div>`
        : '<div class="sc-progress-wrap--idle"></div>';

      return `<div class="ship-card state-${st.state}" data-id="${esc(s.id)}" title="${esc(title)}">
        <div class="sc-info">
          <span class="sc-name">
            <span class="sc-ship">${esc(name)}</span>
            <span class="sc-voyage">${esc(voyage)}</span>
          </span>
          ${berth ? `<span class="sc-berth">${esc(berth)}</span>` : ''}
          <span class="sc-time">${st.label}${st.time}</span>
        </div>
        ${progressBlock}
      </div>`;
    }).join('');

    const empty = Array(Math.max(0, this.MAX_SHIPS - topN.length))
      .fill('<div class="ship-card ship-card--empty"></div>').join('');

    this.el.innerHTML = cards + empty;

    this.el.querySelectorAll('.bar-fill').forEach(el => {
      el.style.width = `${el.dataset.pct}%`;
    });
  },

  /** 排序船舶 */
  _sortShip(a, b) {
    const rank = s => s?._st?.state === 'wait' ? 1 : 0;   // 作业/靠泊=0，预报=1
    const d = rank(a) - rank(b);
    if (d) return d;
    if (rank(a) === 0) {
      const key = s => s.berth || this._timeKey(s);
      return key(a).localeCompare(key(b), undefined, { numeric: true });
    }
    return this._timeKey(a).localeCompare(this._timeKey(b));
  },

  /** 排序时间键：开工 > 靠泊 > 预计抵港 */
  _timeKey(s) {
    return String(s.beg_work_tim || s.rtb || s.eta || '');
  },

  // 泊位映射
  _berthLabel(berth) {
    if (!berth) return '';
    return this.BERTH_LABELS[berth] || '二期';
  },

  /** 作业进度 */
  _progress(s) {
    return {
      iDone: Number(s.i_done_num) || 0,
      iPlan: Number(s.i_plan_num) || 0,
      eDone: Number(s.e_done_num) || 0,
      ePlan: Number(s.e_plan_num) || 0,
    };
  },

  /** 进度百分比字符串 */
  _pct(done, plan) {
    if (!plan) return '--';
    return `${toPct(done, plan)}%`;
  },

  /** 进度历史 SVG 折线图 */
  _sparkline(s) {
    const h = State.sampleShipProgPct(s.id);
    if (h.length < 2) return '';
    const W = 96, H = 30, P = 2;
    const iw = W - P * 2, ih = H - P * 2;
    const x = i => P + (i / (h.length - 1)) * iw;
    const y = v => P + ih - (v / 100) * ih;
    const pts = k => h.map((p, i) => `${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
    return `<svg class="sc-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polyline class="spk-i" vector-effect="non-scaling-stroke" points="${pts('iPct')}"></polyline>
      <polyline class="spk-e" vector-effect="non-scaling-stroke" points="${pts('ePct')}"></polyline>
    </svg>`;
  },

  /** 判定船舶状态 */
  _shipState(s) {
    if (s.beg_work_tim) {
      return { state: 'work', label: '开工：', time: this._fmt(s.beg_work_tim) };
    }
    if (s.rtb) {
      return { state: 'berth', label: '靠泊：', time: this._fmt(s.rtb) };
    }
    return { state: 'wait', label: '预计：', time: this._fmt(s.eta) };
  },

  _fmt(raw) {
    const m = String(raw || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : '--';
  }
};


/* ============================================================
   ShipDetail
   ============================================================ */

const ShipDetail = {
  id: null,

  init() {
    this.wrap   = document.getElementById('ship-detail');
    this.title  = document.getElementById('sd-title');
    this.status = document.getElementById('sd-status');
    this.durInp = document.getElementById('sd-duration');
    if (!this.wrap) return;

    document.getElementById('sd-close').onclick = () => this.close();
    this.durInp.addEventListener('change', () => this.refresh());
    document.getElementById('ship-info').addEventListener('click', (e) => {
      const card = e.target.closest('.ship-card');
      if (!card || card.classList.contains('ship-card--empty') || card.dataset.id == null) return;
      if (this.isOpen() && String(this.id) === String(card.dataset.id)) { this.close(); return; }
      this.open(card.dataset.id);
    });
  },

  isOpen() { return this.id != null; },

  async open(id) {
    this.id = id;
    const ship = this.current();
    this.title.textContent = ship ? `${ship.ship_name || id}  ${ship.voyage || ''}`.trim() : id;
    this.wrap.classList.remove('hidden');

    if (!State.shipProgNumLoaded) {            // 首次打开时 GET 全量船舶作业进度历史
      const ships = await this._fetchAll();
      if (ships) State.setShipProgNum(ships);
    }
    this.render();
  },

  close() {
    this.id = null;
    this.wrap.classList.add('hidden');
  },

  /** 推送到达后由 _route 调用 */
  refresh() { if (this.isOpen()) this.render(); },

  /** 断线重连，若面板打开则重拉一次补齐断线期间数据 */
  async onReconnect() {
    State.shipProgNumLoaded = false;
    if (this.isOpen()) await this.open(this.id);
  },

  async _fetchAll() {
    try {
      const res = await fetch('api/ship_history');
      if (!res.ok) return null;
      const data = await res.json();
      return data.ships || {};
    } catch { return null; }
  },

  /** 当前船舶对象 */
  current() {
    return State.ships.find(s => String(s.id) === String(this.id)) || null;
  },

  /** 渲染（暂为骨架） */
  render() {
    const ship = this.current();
    const pts  = State.shipProgNum[this.id] || [];
    const last = pts[pts.length - 1];
    const plan = Number(ship?.i_plan_num || 0) + Number(ship?.e_plan_num || 0);
    if (this.status) {
      this.status.textContent = last
        ? `${pts.length}, ${last.i_done + last.e_done}${plan ? ' / ' + plan : ''}`
        : '暂无数据';
    }
    // TODO: charts.js
  },
};


/* ============================================================
   Cards
   ============================================================ */

const Cards = {
  /** @param {'rtg'|'qc'|'fl'} type */
  render(type, devices) {
    const cfg = {
      rtg: { listId: 'rtg-cards', countId: 'rtg-count' },
      qc:  { listId: 'qc-cards',  countId: 'qc-count'  },
      fl:  { listId: 'fl-cards',  countId: 'fl-count'  },
    }[type];
    if (!cfg) return;

    // 在线数量
    const online = State.countOnline(devices);
    document.getElementById(cfg.countId).textContent = online;

    const listEl = document.getElementById(cfg.listId);
    if (!devices.length) {
      listEl.innerHTML = '<div class="card-placeholder">暂无数据</div>';
      return;
    }
    listEl.innerHTML = devices.map(d => this._card(type, d)).join('');
  },

  _card(type, d) {
    const esc    = escapeHtml;
    const st     = this._machState(d);
    const stateCls = st === 'online' ? '' : ` ${st}`;
    const loc    = this._loc(type, d);
    const ship   = (d.ship_name || '').slice(0, 10);
    const way    = this._workWay(d.work_way, type);

    return `<div class="card card-${type}${stateCls}">
      <span class="c-bar ${this._bar(d)}"></span>
      <span class="c-id">${esc(d.id)}</span>
      <span class="c-driver">${esc(d.driver || '')}</span>
      ${type === 'qc' ? `<span class="c-ship">${esc(ship)}</span>` : ''}
      ${way ? `<span class="c-way c-way-${esc(d.work_way)}">${esc(way)}</span>` : ''}
      <span class="c-loc">${esc(loc)}</span>
    </div>`;
  },

  _workWay(code, type) {
    if (!code) return '';
    const cfg = Config.data?.work_way;
    if (!cfg) return '';
    if (!cfg.types?.includes(type) || !cfg.display?.includes(code)) return '';
    return cfg.labels?.[code] ?? code;
  },

  _loc(type, d) {
    if (type === 'qc') return d.bay || '';
    if (d.area && d.bay) return `${d.area} - ${d.bay}`;
    if (d.area) return d.area;
    if (d.bay)  return d.bay;
    return '';
  },

  /** 设备状态：'online' | 'fault' | 'offline' */
  _machState(d) {
    if (d.status === '1') return 'online';
    if (d.status === '2' || d.status === '3') return 'fault';
    return 'offline';
  },

  /** 状态条颜色 */
  _bar(d) {
    return `c-${this._machState(d)}`;
  },
};


/* ============================================================
   SSE
   ============================================================ */

const SSEClient = {
  MAX_RETRIES: 0,     // 0 = 不限次数
  BASE_DELAY: 1000,   // 初始延迟
  MAX_DELAY: 30000,   // 上限
  retryCount: 0,

  init() { this.connect(); },

  connect() {
    const es = new EventSource('/events');

    es.onopen = () => {
      this.retryCount = 0;
      console.log('[SSE] 已连接');
      Header.setConnected(true);
      ShipDetail.onReconnect();
    };

    es.onmessage = (e) => {
      try { this._route(JSON.parse(e.data)); }
      catch (_) { /* 心跳 */ }
    };

    es.onerror = () => {
      es.close();
      Header.setConnected(false);
      this._reconnect();
    };
  },

  _reconnect() {
    if (this.MAX_RETRIES > 0 && this.retryCount >= this.MAX_RETRIES) return;
    const delay = Math.min(this.BASE_DELAY * 2 ** this.retryCount, this.MAX_DELAY)
                + Math.random() * 500;
    this.retryCount++;
    setTimeout(() => this.connect(), delay);
  },

  _route(msg) {
    const data = msg.data || [];

    switch (msg.type) {
      case 'init_loc':
      case 'rtg_loc':
        State.merge(data);
        Cards.render('rtg', State.getByType('2'));
        break;

      case 'ym_info':
        State.merge(data);
        Cards.render('rtg', filterByConfig(State.getByType('2'), 'rtg'));
        Cards.render('fl',  filterByConfig(State.getByType('3'), 'fl'));
        break;

      case 'qc_info':
        State.merge(data);
        Cards.render('qc', filterByConfig(State.getByType('1'), 'qc'));
        break;

      case 'ship_info':
        State.ships = data
        Ships.render();
        break;

      case 'ship_progress': {
        State.mergeShipProgress(data);
        if (!msg.init) {
          State.pushShipProgPct(data, msg.ts);
          if (State.shipProgNumLoaded) State.pushShipProgNum(data, msg.ts);
        }
        Ships.render();
        ShipDetail.refresh();
        break;
      }

      case 'ym_stats':
        State.merge(data);
        Charts.update('chart-rtg', filterByConfig(State.getByType('2'), 'rtg'));
        Charts.update('chart-fl',  filterByConfig(State.getByType('3'), 'fl'));
        Charts.syncYAxis();
        Charts.updateSummaries();
        break;

      case 'qc_stats':
        State.merge(data);
        Charts.update('chart-qc', filterByConfig(State.getByType('1'), 'qc'));
        Charts.syncYAxis();
        Charts.updateSummaries();
        break;

      case 'stats_mode':
        State.statsMode = msg.data?.mode || 'shift';
        Charts.updateTitles();
        break;
    }
  },
};


/* ============================================================
   启动
   ============================================================ */

document.addEventListener('DOMContentLoaded', async () => {
  Header.init();
  Ships.init();
  ShipDetail.init();
  Charts.init();
  State._initShipProgPct();
  await Config.load();
  SSEClient.init();
});