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

/** epoch ms → 'MM-DD HH:MM' */
function fmtTs(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** epoch ms → 'YYYY-MM-DDTHH:MM'（datetime-local 的值，本地时间） */
function fmtInput(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 'YYYY-MM-DD HH:MM[:SS]' → epoch ms；失败返回 null */
function parseTs(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}


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

/** 取属于该船的作业设备
 *  场桥/堆高机按航次号匹配，来源按 config.ship_device_src 过滤：
 *    'both'（默认）= 装船绑定 + 卸船指令兜底都参与
 *    'bind'        = 只用装船绑定，cmd 兜底不高亮
 *  岸桥没有 voyage_src（船来自 SHIP_MACH_PLAC），不受该配置影响 */
function devicesOfShip(ship, list) {
  if (!ship) return [];
  const id       = String(ship.id ?? '');
  const onlyBind = Config.data?.ship_device_src === 'bind';
  return (list || []).filter(d => {
    if (String(d.voyage ?? '') !== id) return false;
    return !onlyBind || d.voyage_src === undefined || d.voyage_src === 'bind';
  });
}

/** 卡片列表：配置键 → 设备 id 首位 / 列表元素 / 计数元素 */
const CARD_LISTS = {
  qc:  { prefix: '1', listId: 'qc-cards',  countId: 'qc-count'  },
  rtg: { prefix: '2', listId: 'rtg-cards', countId: 'rtg-count' },
  fl:  { prefix: '3', listId: 'fl-cards',  countId: 'fl-count' },
};


/* ============================================================
   Auth - 当前账号角色验证（服务端 SSE 首帧下发，见 web/sse_server.py）
   ============================================================ */

const Auth = {
  role: document.documentElement.dataset.role || 'dashboard',

  /** 仅 full 角色可见的入口（按 id 加 .hidden） */
  FULL_ONLY: ['qc-expand', 'focus-toggle', 'focus-tip'],

  get full()   { return this.role === 'full'; },
  get denied() { return !this.full; },

  /** 应用权限：隐藏不可用入口，并把角色写到 <html> 供 CSS 切换 header 形态 */
  apply() {
    const root = document.documentElement;
    root.dataset.role = this.role;          // full → 紧凑 header；dashboard → 原样
    document.title = this.full ? '中控作业监控平台' : '机械设备监控看板';

    for (const id of this.FULL_ONLY) {
      document.getElementById(id)?.classList.toggle('hidden', this.denied);
    }
    document.getElementById('ship-info')?.classList.toggle('no-detail', this.denied);
    if (this.denied && DetailPanel.mode) DetailPanel.close();
  },

  setRole(role) {
    this.role = role || 'dashboard';
    this.apply();
  },
};


/* ============================================================
   Theme - 亮/暗主题切换
   初值由 js/theme.js 在 head 中写入 html[data-theme]，此处只读取与切换
   ============================================================ */

const Theme = {
  KEY: 'theme',
  current: 'dark',

  init() {
    this.current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => this.toggle());
    this._sync(btn);
  },

  toggle() { this.set(this.current === 'light' ? 'dark' : 'light'); },

  set(theme) {
    this.current = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = this.current;
    try { localStorage.setItem(this.KEY, this.current); }
    catch (e) { /* localStorage 满/被禁用时不致命 */ }

    const btn = document.getElementById('theme-toggle');
    if (btn) this._sync(btn);
    Charts.refreshTheme();        // Chart.js 把颜色烘进实例，必须重建
  },

  /** 提示语指向"将要切到的"主题；图标由 CSS 依 data-theme 切换 */
  _sync(btn) {
    const label = `切换到${this.current === 'light' ? '深色' : '浅色'}主题`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
  },
};


/* ============================================================
   Focus - 选中船舶时是否高亮作业该船的设备
   纯前端偏好，localStorage 记忆；初值为开（与加开关前的行为一致）
   ============================================================ */

const Focus = {
  KEY: 'ship-focus',
  on: true,

  init() {
    this.on = localStorage.getItem(this.KEY) !== '0';
    const btn = document.getElementById('focus-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => this.toggle());
    this._sync(btn);
  },

  toggle() { this.set(!this.on); },

  set(on) {
    this.on = !!on;
    try { localStorage.setItem(this.KEY, this.on ? '1' : '0'); }
    catch (e) { /* localStorage 满/被禁用时不致命 */ }

    const btn = document.getElementById('focus-toggle');
    if (btn) this._sync(btn);
    DetailPanel._markActive();        // 立即生效，无需等下一次推送
  },

  _sync(btn) {
    btn.classList.toggle('is-active', this.on);
    btn.setAttribute('aria-pressed', this.on ? 'true' : 'false');
  },
};


/* ============================================================
   State
   ============================================================ */

const State = {
  devices: {},
  ships: [],
  shipProgPct: {},          // { [id]: [{ t, iPct, ePct }] }      百分比历史，用于 sparkline
  shipProgNum: {},          // { [id]: [{ t, i_done, e_done }] }  详细箱量历史，用于 shipDetail
  qcMoves: {},              // { [voyage]: [{ id, hour, moves }] }  岸桥 move 数（按船）
  shipProgNumLoaded: false, // 是否已 GET 详细箱量历史
  qcMovesLoaded: false,     // 是否已 GET 岸桥 move 数
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

  /** 按 id 复用旧对象合并 ship_info：保留前端挂在对象上的字段（如 dur） */
  mergeShips(list) {
    const old = new Map((this.ships || []).map(s => [String(s.id), s]));
    this.ships = (list || []).map(s => Object.assign(old.get(String(s.id)) || {}, s));
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

  /** 追加岸桥 move 数（GET 与 SSE 共用；按 (岸桥, 小时) upsert） */
  pushQcMove(list) {
    for (const r of list || []) {
      if (r.id == null || !r.hour) continue;
      const arr = (this.qcMoves[r.voyage ?? ''] ||= []);
      const hit = arr.find(p => String(p.id) === String(r.id) && p.hour === r.hour);
      if (hit) hit.moves = Number(r.moves) || 0;
      else arr.push({ id: r.id, hour: r.hour, moves: Number(r.moves) || 0 });
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
    DetailPanel._markActive();
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
    const ts = parseTs(raw);
    return ts ? fmtTs(ts) : '--';
  }
};


/* ============================================================
   DetailPanel
   ============================================================ */

const DetailPanel = {
  mode: null,   // null | 'ship' | 'qc'

  init() {
    this.el   = document.getElementById('detail-panel');
    this.col  = document.querySelector('.center-col');
    this.slot = {
      ship: document.getElementById('ship-detail'),
      qc:   document.getElementById('qc-detail'),
    };
    if (!this.el) return;

    document.getElementById('sd-close').onclick = () => this.close();
    document.getElementById('qd-close').onclick = () => this.close();

    document.getElementById('ship-info').addEventListener('click', (e) => {
      if (Auth.denied) return;                              // 基础看板：船舶卡片不可点
      const card = e.target.closest('.ship-card');
      if (!card || card.classList.contains('ship-card--empty') || card.dataset.id == null) return;
      if (this.mode === 'ship' && String(ShipDetail.id) === String(card.dataset.id)) { this.close(); return; }
      this.openShip(card.dataset.id);
    });

    document.getElementById('qc-expand').onclick = () => this.openQc();
  },

  isOpen() { return this.mode != null; },

  /** 从船舶卡片打开：ship + qc */
  async openShip(id) {
    if (Auth.denied) return;                   // 兜底：devtools 直接调用
    const fresh = this.mode !== 'ship';        // 从关闭态 / QC 态打开船舶面板 → 强制刷新一次 cntr
    this.mode = 'ship';
    this._show({ ship: true, qc: true });
    this._markActive(id);
    await Promise.all([ShipDetail.show(id), QcDetail.show(id, 'ship'), CntrDetail.show(id, fresh)]);
  },

  /** 从 qc 面板单独打开：仅 qc */
  async openQc(id = null) {
    if (Auth.denied) return;                   // 兜底：devtools 直接调用
    this.mode = 'qc';
    this._show({ ship: false, qc: true });
    this._markActive();
    await QcDetail.show(id, 'all');
  },

  close() {
    this.mode = null;
    this.col.classList.remove('detail-open');
    ShipDetail.setVisible(false);
    QcDetail.setVisible(false);
    CntrDetail.setVisible(false);
    this._markActive();
  },

  /** 推送到达 */
  refresh() {
    ShipDetail.refresh();
    QcDetail.refresh();
  },

  /** 断线重连 */
  async onReconnect() {
    State.shipProgNumLoaded = false;
    State.qcMovesLoaded = false;
    if (this.mode === 'ship') {
      await ShipDetail.show(ShipDetail.id);
      await QcDetail.show(QcDetail.id, QcDetail.scope);
    }
    if (this.mode === 'qc') await QcDetail.show(QcDetail.id, QcDetail.scope);
  },

  _show({ ship, qc }) {
    this.slot.ship.classList.toggle('hidden', !ship);
    this.slot.qc.classList.toggle('hidden', !qc);
    ShipDetail.setVisible(ship);
    CntrDetail.setVisible(ship);
    QcDetail.setVisible(qc);
    this.el.dataset.mode = ship ? 'ship' : 'qc';
    this.col.classList.add('detail-open');
  },

  /** 标记当前展开的船舶卡片和相关作业设备卡片 */
  _markActive(id = this.mode === 'ship' ? ShipDetail.id : null) {
    const info = document.getElementById('ship-info');
    const ship = id != null ? State.ships.find(s => String(s.id) === String(id)) : null;

    // 船卡片选中态：始终反映"正在查看的船"，不受高亮开关影响
    if (info) {
      info.classList.toggle('has-active', id != null);
      info.querySelectorAll('.ship-card').forEach(el => {
        el.classList.toggle('is-active', id != null && String(el.dataset.id) === String(id));
      });
    }

    // 岸桥 / 场桥 / 堆高机：关闭高亮时 focusShip 恒为 null，
    // 自然清空 is-active / has-active，无需额外的清理分支
    const focusShip = Focus.on ? ship : null;
    for (const [type, cfg] of Object.entries(CARD_LISTS)) {
      const listEl = document.getElementById(cfg.listId);
      if (!listEl) continue;
      const working = new Set(
        devicesOfShip(focusShip, filterByConfig(State.getByType(cfg.prefix), type))
          .map(d => String(d.id))
      );
      listEl.classList.toggle('has-active', focusShip != null);
      listEl.querySelectorAll('.card').forEach(el => {
        el.classList.toggle('is-active', working.has(String(el.dataset.id)));
      });
    }
  },
};


const ShipDetail = {
  id: null,
  visible: false,
  t0: null,
  dur: 0,

  init() {
    this.el = {
      ship:    document.getElementById('sd-ship'),
      voyage:  document.getElementById('sd-voyage'),
      progNum: document.getElementById('sd-progress-num'),
      progPct: document.getElementById('sd-progress-pct'),
      progBar: document.getElementById('sd-progress-bar'),
      dur:     document.getElementById('sd-duration'),
      end:     document.getElementById('sd-endtime'),
    };
    this.el.dur.addEventListener('change', () => this.onDurationInput());
    this.el.end.addEventListener('change', () => this.onEndTimeInput());
  },

  async show(id) {
    if (!this.visible) return;                      // 由 DetailPanel 保证
    this.id = id;
    const ship = State.ships.find(s => String(s.id) === String(id));
    this.t0 = parseTs(ship?.beg_work_tim);
    this.el.ship.textContent   = ship?.ship_name || id;
    this.el.voyage.textContent = ship?.voyage || '';
    this.dur = Number(ship?.dur) || 0;

    if (!State.shipProgNumLoaded) {                 // 首次 GET 全量
      const ships = await this._fetchAll();
      if (ships) State.setShipProgNum(ships);
    }
    this.syncTimeInputs();
    this.refresh();
    Charts.resizeShipDetail('sd-chart');
  },

  /** 参考线起点：开工时刻 → 首个采样点 → 当前时间 */
  startTs() {
    return this.t0 ?? State.shipProgNum[this.id]?.[0]?.t ?? Date.now();
  },

  onDurationInput() {
    this.setDur(Number(this.el.dur.value) || 0);
  },

  onEndTimeInput() {
    const end = parseTs(this.el.end.value);
    this.setDur(end && end > this.startTs() ? (end - this.startTs()) / 3600000 : 0);
  },

  setDur(hours) {
    this.dur = Math.max(0, Math.round((Number(hours) || 0) * 10) / 10);
    const s = State.ships.find(x => String(x.id) === String(this.id));
    if (s) s.dur = this.dur || undefined; 
    this.syncTimeInputs();
    this.refresh();
  },

  syncTimeInputs() {
    this.el.dur.value = this.dur > 0 ? this.dur : '';
    this.el.end.value = this.dur > 0
      ? fmtInput(this.startTs() + this.dur * 3600000)
      : '';
  },

  setVisible(v) { 
    this.visible = v;
    if (!v) { this.id = null; this.t0 = null; }
  },

  refresh() { if (this.visible && this.id != null) this.render(); },

  async _fetchAll() {
    try {
      const res = await fetch('api/ship_history');
      if (!res.ok) return null;
      const data = await res.json();
      return data.ships || {};
    } catch { return null; }
  },

  render() {
    const ship = State.ships.find(s => String(s.id) === String(this.id));
    const pts  = State.shipProgNum[this.id] || [];
    const last = pts[pts.length - 1];

    const done = last ? last.i_done + last.e_done : 0;
    const plan = Number(ship?.i_plan_num || 0) + Number(ship?.e_plan_num || 0);
    const pct  = toPct(done, plan);
    this.el.progNum.textContent = last && plan
      ? `${done}/${plan} (剩余 ${Math.max(0, plan - done)})` 
      : '--';
    this.el.progPct.textContent  = last && plan ? `${pct}%` : '';
    this.el.progBar.style.width = `${pct}%`;

    Charts.renderShipDetail('sd-chart', {
      points: pts, plan, t0: this.t0, dur: this.dur,
    });
  },
};


const QcDetail = {
  id: null,
  scope: 'ship',        // 'ship' 只显示该航次的岸桥；'all' 显示全部岸桥
  visible: false,

  async show(id, scope = 'ship') {
    this.id = id;
    this.scope = scope;
    if (!State.qcMovesLoaded) {                     // 首次打开 GET 全量，之后靠 SSE 增量
      const rows = await this._fetchAll();
      if (rows) { State.pushQcMove(rows); State.qcMovesLoaded = true; }
    }
    this.refresh();
    Charts.resizeQcHeat('qd-chart');
  },

  setVisible(v) {
    this.visible = v;
    if (!v) { this.id = null; Charts.destroyQcHeat('qd-chart'); }   // 隐藏即销毁，避免 0 尺寸画布
  },

  refresh() { if (this.visible && (this.scope === 'all' || this.id != null)) this.render(); },

  async _fetchAll() {
    try {
      const res = await fetch('api/qc_move');
      return res.ok ? await res.json() : null;      // 数组 [{id, hour, moves}]
    } catch { return null; }
  },

  /** 纵轴 = 当前在作业该船的岸桥 ∪ 该船有过 move 数据的岸桥 */
  qcIds() {
    const qcs = filterByConfig(State.getByType('1'), 'qc');
    if (this.scope !== 'ship') return qcs.map(d => d.id);

    const ship = State.ships.find(s => String(s.id) === String(this.id));
    const live = new Set(devicesOfShip(ship, qcs).map(d => String(d.id)));   // 正在作业
    const past = new Set((State.qcMoves[this.id] || []).map(r => String(r.id))); // 作业过
    return qcs.filter(d => live.has(String(d.id)) || past.has(String(d.id))).map(d => d.id);
  },

  render() {
    const yLabels = this.qcIds();                    // 纵轴 = 当前船的岸桥
    const empty   = yLabels.length === 0;

    document.getElementById('qd-empty')?.classList.toggle('hidden', !empty);
    document.querySelector('#qc-detail .qd-heat-wrap')?.classList.toggle('hidden', empty);
    if (empty) { Charts.destroyQcHeat('qd-chart'); return; }   // 清掉上一艘的残留

    Charts.syncQcLegend();
    Charts.renderQcHeat('qd-chart', {
      rows: this.scope === 'ship'
        ? (State.qcMoves[this.id] || [])                     // 只画该船的小时
        : Object.values(State.qcMoves).flat(),               // 从岸桥卡片打开：全部
      yLabels,
    });
  },
};


const CntrDetail = {
  id: null,
  cache: {},                     // { [voyage]: { rows, ts } }
  REFRESH_MIN: 10,               // 每整十分钟对齐刷新
  MANUAL_GAP_MS: 60 * 1000,      // 手动刷新最小间隔
  timer: null,
  btnTimer: null,                // 按钮冷却恢复用的定时器

  init() {
    this.el = {
      body: document.getElementById('cntr-body'),
      time: document.getElementById('cntr-time'),
      btn:  document.getElementById('cntr-refresh'),
    };
    this.el.btn.addEventListener('click', () => this.load(true));
  },

  /** 打开船舶面板（刷新）或面板内切换船只（缓存优先）*/
  async show(id, force = false) {
    this.id = String(id);
    this._arm();
    const hit = this.cache[this.id];
    if (hit && !force) { this.render(hit.rows, hit.ts, hit.diff); return; }   // 只换显示，不发请求
    if (!hit) this.el.body.innerHTML = '<span class="cntr-empty">加载中…</span>';
    await this.load();
  },

  /** 隐藏时收尾：清当前航次 + 定时器 */
  setVisible(v) {
    if (v) return;
    this.id = null;
    clearTimeout(this.timer);    this.timer = null;
    clearTimeout(this.btnTimer); this.btnTimer = null;
  },

  /** 对齐到下一个整十分钟（:00/:10/:20…）自动刷新 */
  _arm() {
    clearTimeout(this.timer);
    const MS = this.REFRESH_MIN * 60_000;
    this.timer = setTimeout(() => { this.load(); this._arm(); }, MS - (Date.now() % MS) + 300);
  },

  /** 按钮冷却：数据查过后按钮禁用，到期自动恢复 */
  _cool() {
    clearTimeout(this.btnTimer);
    const left = this.MANUAL_GAP_MS - (Date.now() - (this.cache[this.id]?.ts || 0));
    this.el.btn.disabled = left > 0;
    if (left > 0) this.btnTimer = setTimeout(() => { this.el.btn.disabled = false; }, left + 200);
  },

  /** 分界组序号：A=0 / B=1 / 其他（含 '-'）=2 */
  _group(area) {
    const c = String(area ?? '').trim().toUpperCase()[0];
    if (c === 'A') return 0;
    if (c === 'B') return 1;
    return 2;
  },

  /** rows → 场区合计 { area: sum } */
  _areaSum(rows) {
    const m = {};
    for (const r of rows || []) m[r.area] = (m[r.area] ?? 0) + r.cnt;
    return m;
  },

  /** 相比上次减少的场区集合；没有上次数据时返回空集 */
  _diffDecrease(prevRows, nextRows) {
    if (!prevRows) return new Set();
    const prev = this._areaSum(prevRows);
    const next = this._areaSum(nextRows);
    const hasArea = a => {                       // 无场区（'-' / 空）不参与对比
      const s = String(a ?? '').trim();
      return s !== '' && s !== '-';
    };
    return new Set(Object.keys(prev).filter(a => hasArea(a) && (next[a] ?? 0) < prev[a]));
  },

  /** manual=true 手动刷新：60s 内不重复查 */
  async load(manual = false) {
    if (!this.id) return;
    if (manual && Date.now() - (this.cache[this.id]?.ts || 0) < this.MANUAL_GAP_MS) return;
    if (manual) this.el.btn.disabled = true;              // 请求在途，防连点

    const data = await fetch(`api/ship_cntr?voyage=${encodeURIComponent(this.id)}`,
                             { cache: 'no-store' })
                       .then(r => r.ok ? r.json() : null)
                       .catch(() => null);
    if (!data || String(data.voyage) !== String(this.id)) {
      this._cool();                                       // 失败/过期：只恢复按钮，表格保持原样
      return;
    }
    const prev = this.cache[this.id]?.rows;
    if (data.ts) this.cache[this.id] = {
      rows: data.rows || [],
      ts: data.ts,
      diff: this._diffDecrease(prev, data.rows),
    };
    const { rows = [], ts = 0, diff = new Set() } = this.cache[this.id] || {};
    this.render(rows, ts, diff);
  },

  render(rows, ts, diff = new Set()) {
    const el = this.el;
    el.time.textContent = ts ? `数据时间 ${fmtTs(ts).slice(-5)}` : '';
    this._cool();
    if (!rows.length) {
      el.body.innerHTML = '<span class="cntr-empty">暂无数据</span>';
      return;
    }
    const portOf = r => r.port_nam ?? (r.disc_port === '-' ? '未定' : r.disc_port);

    const ports = [...new Set(rows.map(portOf))].sort((a, b) => a.localeCompare(b, 'zh'));
    const byArea = new Map();                       // area → Map(port → cnt)
    for (const r of rows) {
      const m = byArea.get(r.area) ?? new Map();
      m.set(portOf(r), (m.get(portOf(r)) ?? 0) + r.cnt);
      byArea.set(r.area, m);
    }

    // '-' 置底，其余沿用字母+数字序
    const areas = [...byArea.keys()].sort((a, b) =>
      ((a === '-' ? 1 : 0) - (b === '-' ? 1 : 0))
      || String(a).localeCompare(String(b), undefined, { numeric: true }));

    const colSum = new Map();
    for (const m of byArea.values())
      for (const [p, n] of m) colSum.set(p, (colSum.get(p) ?? 0) + n);
    const grand = [...colSum.values()].reduce((s, n) => s + n, 0);

    // ② 组首行加 ct-group-start，用于画分界
    let prevG = null;
    const body = areas.map(a => {
      const g = this._group(a);
      const head = g !== prevG;
      prevG = g;

      const m   = byArea.get(a);
      const sum = [...m.values()].reduce((s, n) => s + n, 0);
      const cls = `${head ? 'ct-group-start' : ''}${diff.has(a) ? ' ct-decrease' : ''}`.trim();

      return `<tr class="${cls}">
        <td class="ct-area">${escapeHtml(a)}</td>`
        + ports.map(p => `<td>${m.get(p) ?? ''}</td>`).join('')
        + `<td class="ct-sum">${sum}</td></tr>`;
    }).join('');

    el.body.innerHTML = `<table class="cntr-table">
      <thead><tr><th>场区</th>${ports.map(p => `<th>${escapeHtml(p)}</th>`).join('')}<th class="ct-sum">合计</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td>合计</td>
        ${ports.map(p => `<td>${colSum.get(p) ?? ''}</td>`).join('')}
        <td class="ct-sum">${grand}</td>
      </tr></tfoot>
    </table>`;
  },
};


/* ============================================================
   Cards
   ============================================================ */

const Cards = {
  /** @param {'rtg'|'qc'|'fl'} type */
  render(type, devices) {
    const cfg = CARD_LISTS[type];
    if (!cfg) return;

    // 在线数量
    const online = State.countOnline(devices);
    document.getElementById(cfg.countId).textContent = online;

    const listEl = document.getElementById(cfg.listId);
    if (!devices.length) {
      listEl.innerHTML = '<div class="card-placeholder">暂无数据</div>';
      DetailPanel._markActive();        // 空列表清掉残留高亮
      return;
    }
    listEl.innerHTML = devices.map(d => this._card(type, d)).join('');
    DetailPanel._markActive();          // 重建 DOM 后恢复 is-active
  },

  _card(type, d) {
    const esc    = escapeHtml;
    const st     = this._machState(d);
    const stateCls = st === 'online' ? '' : ` ${st}`;
    const loc    = this._loc(type, d);
    const ship   = this._shipLabel(d.ship_name);
    const way    = this._workWay(d.work_way, type);

    return `<div class="card card-${type}${stateCls}" data-id="${esc(d.id)}">
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

  _shipLabel(name) {
    return String(name ?? '').trim().replace(/外$/, '');
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
      DetailPanel.onReconnect();
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
      case 'auth':                             // 服务端首个消息，决定可用入口
        Auth.setRole(msg.data?.role);
        break;

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
        State.mergeShips(data);
        Ships.render();
        break;

      case 'ship_progress': {
        State.mergeShipProgress(data);
        if (!msg.init) {
          State.pushShipProgPct(data, msg.ts);
          if (State.shipProgNumLoaded) State.pushShipProgNum(data, msg.ts);
        }
        Ships.render();
        DetailPanel.refresh();
        break;
      }

      case 'ym_stats':
        State.merge(data);
        Charts.updateDeviceChart('chart-rtg', filterByConfig(State.getByType('2'), 'rtg'));
        Charts.updateDeviceChart('chart-fl',  filterByConfig(State.getByType('3'), 'fl'));
        Charts.syncDeviceAxis();
        Charts.updateDeviceSummaries();
        break;

      case 'qc_stats':
        State.merge(data);
        Charts.updateDeviceChart('chart-qc', filterByConfig(State.getByType('1'), 'qc'));
        Charts.syncDeviceAxis();
        Charts.updateDeviceSummaries();
        break;

      case 'stats_mode':
        State.statsMode = msg.data?.mode || 'shift';
        Charts.updateDeviceTitles();
        break;

      case 'qc_move':
        State.pushQcMove(data);
        QcDetail.refresh();
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
  DetailPanel.init();
  ShipDetail.init();
  CntrDetail.init()
  Charts.init();
  State._initShipProgPct();
  Auth.apply();               // 首帧即按最小权限隐藏入口，避免闪出后又收回
  Theme.init();               // 初值已在 head 中生效，这里只绑定按钮
  Focus.init();
  await Config.load();
  SSEClient.init();
});