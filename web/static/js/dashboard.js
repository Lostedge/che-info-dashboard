/**
 * 码头机械设备监控看板
 * ============================================================
 * State.devices  — 全量设备, 按 id merge
 * State.ships    — 船舶列表
 *
 * SSE → _route() → State.merge() → render()
 */

/* ============================================================
   State
   ============================================================ */

const State = {
  devices: {},
  ships: [],

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

  init() {
    this.el = document.getElementById('ship-info');
  },

  render(list) {
    const ships = list || State.ships;
    if (!ships.length) {
      this.el.innerHTML = '<span class="ship-placeholder">暂无在港船舶</span>';
      return;
    }

    // 取"最早到达的 MAX_SHIPS 艘"（按 开工/靠泊/抵港 时间降序，取末尾）
    const top4 = [...ships]
      .map(s => ({ ...s, _st: this._shipState(s) }))
      .sort((a, b) => this._timeKey(b).localeCompare(this._timeKey(a)))
      .slice(-this.MAX_SHIPS);

    const cards = top4.map(s => {
      const st = s._st;
      const p = this._progress(s);
      const { name, voyage } = this._splitLabel(s.ship_label || s.id || '--');

      const progress = (p.iPlan > 0 || p.ePlan > 0)
        ? `<div class="sc-progress">
             <span class="scp-label">卸</span>
             <span class="scp-num"><b>${p.iDone}</b>/${p.iPlan}</span>
             <span class="scp-pct">${this._pct(p.iDone, p.iPlan)}</span>
             <span class="scp-label">装</span>
             <span class="scp-num"><b>${p.eDone}</b>/${p.ePlan}</span>
             <span class="scp-pct">${this._pct(p.eDone, p.ePlan)}</span>
           </div>`
        : '';

      return `<div class="ship-card state-${st.css}" title="${s.ship_label || s.id}">
        <div class="sc-info">
          <span class="sc-name">
            <span class="sc-ship">${name}</span>
            <span class="sc-voyage">${voyage}</span>
          </span>
          <span class="sc-time">${st.label} ${st.time}</span>
        </div>
        ${progress}
      </div>`;
    }).join('');

    const empty = Array(Math.max(0, this.MAX_SHIPS - top4.length))
      .fill('<div class="ship-card ship-card--empty"></div>').join('');

    this.el.innerHTML = cards + empty;
  },

  /** 排序时间键：开工 > 靠泊 > 预计抵港 */
  _timeKey(s) {
    return String(s.beg_work_tim || s.rtb || s.eta || '');
  },

  /** 作业进度 */
  _progress(s) {
    return {
      iDone: s.i_done_num ?? 0,
      iPlan: s.i_plan_num ?? 0,
      eDone: s.e_done_num ?? 0,
      ePlan: s.e_plan_num ?? 0,
    };
  },

  /** 进度百分比 */
  _pct(done, plan) {
    if (!plan) return '--';
    return `${Math.round((done / plan) * 100)}%`;
  },

  /** 拆分 ship_label: "船名 进口/出口" → { name, voyage } */
  _splitLabel(label) {
    const idx = label.lastIndexOf(' ');
    if (idx === -1) return { name: label.substring(0, 22), voyage: '' };
    return {
      name:   label.substring(0, idx).substring(0, 18),
      voyage: label.substring(idx + 1).substring(0, 15),
    };
  },

  /** 判定船舶状态 */
  _shipState(s) {
    if (s.beg_work_tim) {
      return { css: 'work', label: '开工时间：', time: this._fmt(s.beg_work_tim) };
    }
    if (s.rtb) {
      return { css: 'berth', label: '靠泊时间：', time: this._fmt(s.rtb) };
    }
    return { css: 'wait', label: '预计抵港：', time: this._fmt(s.eta) };
  },

  _fmt(raw) {
    const m = String(raw || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : '--';
  }
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
    const alive  = d.status !== '0';
    const loc    = this._loc(type, d);
    const driver = alive ? (d.driver || '') : '';
    const ship   = (alive && type === 'qc') ? (d.ship_name || '').slice(0, 10) : '';
    const locStr = (alive || type === 'rtg') ? loc : '';

    return `<div class="card${alive ? '' : ' offline'}" title="${d.id}  ${d.driver || ''}  ${loc}">
      <span class="c-bar ${this._bar(d)}"></span>
      <span class="c-id">${d.id}</span>
      <span class="c-driver">${driver}</span>
      ${type === 'qc' ? `<span class="c-ship">${ship}</span>` : ''}
      <span class="c-loc">${locStr}</span>
    </div>`;
  },

  _loc(type, d) {
    if (type === 'qc') return d.bay || '';
    if (d.area && d.bay) return `${d.area} - ${d.bay}`;
    if (d.area) return d.area;
    if (d.bay)  return d.bay;
    return '';
  },

  /** 状态条颜色 */
  _bar(d) {
    switch (d.status) {
      case '1': return 'c-online';
      case '2':
      case '3': return 'c-fault';
      default: return 'c-offline';
    }
  },
};


/* ============================================================
   SSE
   ============================================================ */

const SSEClient = {
  init() {
    const es = new EventSource('/events');

    es.onopen = () => {
      console.log('[SSE] 已连接');
      Header.setConnected(true);
    };

    es.onmessage = (e) => {
      try { this._route(JSON.parse(e.data)); }
      catch (_) { /* 心跳 */ }
    };

    es.onerror = () => Header.setConnected(false);
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
        Cards.render('rtg', State.getByType('2'));
        Cards.render('fl',  State.getByType('3'));
        break;

      case 'qc_info':
        State.merge(data);
        Cards.render('qc', State.getByType('1'));
        break;

      case 'ship_info':
        State.ships = data;
        Ships.render(data);
        break;

      case 'ship_progress':
        State.mergeShipProgress(data);
        Ships.render();
        break;

      case 'ym_stats':
        State.merge(data);
        Charts.update('chart-rtg', State.getByType('2'));
        Charts.update('chart-fl',  State.getByType('3'));
        Charts.syncYAxis();
        Charts.updateSummaries();
        break;

      case 'qc_stats':
        State.merge(data);
        Charts.update('chart-qc', State.getByType('1'));
        Charts.syncYAxis();
        Charts.updateSummaries();
        break;
    }
  },
};


/* ============================================================
   启动
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  Header.init();
  Ships.init();
  Charts.init();
  SSEClient.init();
});