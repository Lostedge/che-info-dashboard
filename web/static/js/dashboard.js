/**
 * 码头机械设备监控看板
 * ============================================================
 * State.devices  — 全量设备, 按 id merge
 * State.ships    — 船舶列表
 *
 * SSE → _route() → State.merge() → render()
 */

/** 转义 HTML 特殊字符 */
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
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
      const esc = escapeHtml;
      const { name, voyage } = this._splitLabel(s.ship_label || s.id || '--');
      return `<div class="ship-card state-${st.css}" title="${esc(s.ship_label || s.id)}">
        <span class="sc-name">
          <span class="sc-ship">${esc(name)}</span>
          <span class="sc-voyage">${esc(voyage)}</span>
        </span>
        <span class="sc-time">${st.label} ${st.time}</span>
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
    const esc    = escapeHtml;
    const st     = this._machState(d);
    const stateCls = st === 'online' ? '' : ` ${st}`;
    const loc    = this._loc(type, d);
    const ship   = (d.ship_name || '').slice(0, 10);
    const way    = this._workWay(d.work_way);

    return `<div class="card card-${type}${stateCls}">
      <span class="c-bar ${this._bar(d)}"></span>
      <span class="c-id">${esc(d.id)}</span>
      <span class="c-driver">${esc(d.driver || '')}</span>
      ${type === 'qc' ? `<span class="c-ship">${esc(ship)}</span>` : ''}
      ${way ? `<span class="c-way c-way-${esc(d.work_way)}">${esc(way)}</span>` : ''}
      <span class="c-loc">${esc(loc)}</span>
    </div>`;
  },

  _workWay(workWay) {
    if (workWay === 'SI') return '卸船';
    if (workWay === 'SO') return '装船';
    if (workWay === 'TI') return '收箱';
    if (workWay === 'TO') return '提箱';
    return '';
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
        Cards.render('rtg', filterByConfig(State.getByType('2'), 'rtg'));
        Cards.render('fl',  filterByConfig(State.getByType('3'), 'fl'));
        break;

      case 'qc_info':
        State.merge(data);
        Cards.render('qc', filterByConfig(State.getByType('1'), 'qc'));
        break;

      case 'ship_info':
        State.ships = data;
        Ships.render(data);
        break;

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
    }
  },
};


/* ============================================================
   启动
   ============================================================ */

document.addEventListener('DOMContentLoaded', async () => {
  Header.init();
  Ships.init();
  Charts.init();
  await Config.load();
  SSEClient.init();
});