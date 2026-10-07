/**
 * Chart.js 图表模块
 * 依赖: Chart 全局 (chart.umd.min.js)
 *
 * 图表：
 *   设备作业量柱状图（chart-rtg/qc/fl）→ buildDeviceChartData / deviceChart*
 *   船舶详情折线图（sd-chart）          → buildShipDetailData / shipDetail*
 *   岸桥 move 色块图（qd-chart）        → buildQcHeatData / qcHeatScale / qcHeat*
 */


/* ============================================================
   数据构建
   ============================================================ */

/**
 * 构建设备作业量柱状图数据
 * @param list [{ id, day_20, day_40 }]
 * @returns {{ labels: string[], d20: number[], d40: number[] }}
 */
function buildDeviceChartData(list) {
  const rows = [...(list || [])].sort((a, b) => a.id.localeCompare(b.id));
  return {
    labels: rows.map(d => d.id),
    d20:    rows.map(d => d.day_20 ?? 0),
    d40:    rows.map(d => d.day_40 ?? 0),
  };
}


/**
 * 构建船舶详情图数据
 * @param points [{ t, i_done, e_done }] 累计值，按 t 升序
 * @param plan   总计划箱量（i_plan + e_plan）
 * @param t0     开工时刻 epoch ms（可为 null）
 * @param dur    预计作业时长（小时）
 */
function buildShipDetailData(points, plan, t0, dur) {
  const pts   = (points || []).filter(p => p.t != null);
  const start = t0 ?? pts[0]?.t ?? Date.now();
  const H     = 3600 * 1000;
  const durMs = (Number(dur) || 0) * H;
  const hasRef = plan > 0 && durMs > 0;
  const end   = durMs > 0 ? start + durMs : null;

  // x 刻度：开工起点 + 各采样点 + 参考线终点
  const times = [...new Set([start, ...(end ? [end] : []), ...pts.map(p => p.t)])]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  // 实际累计（起点锚定 0）
  const actual = times.map(t => {
    if (t <= start) return 0;
    const hit = pts.find(p => Math.abs(p.t - t) < 60_000);
    return hit ? (Number(hit.i_done) + Number(hit.e_done)) : null;
  });

  /** 等速线：用时 d 跑完 plan；到点即断（不越出 plan、不改轴范围） */
  const refLine = d => times.map(t =>
    (hasRef && d > 0 && t >= start && t <= start + d)
      ? plan * ((t - start) / d) : null);

  return {
    labels: times.map(fmtTs),
    actual,
    ref:      refLine(durMs),
    refEarly: durMs > H ? refLine(durMs - H) : times.map(() => null),
    refLate:  refLine(durMs + H),
  };
}


/**
 * 构建岸桥色块图点集（扁平行 → 矩阵）
 * @param rows    [{ id, hour, moves }]，hour 与 xLabels 同格式（'HH:00'）
 * @param xLabels 横轴时段标签，升序
 * @param yLabels 纵轴岸桥编号
 * @returns {Array<{ x: string, y: string, v: number|null }>} 缺格 v = null
 */
function buildQcHeatData(rows, xLabels, yLabels) {
  const xi = new Map(xLabels.map((h, i) => [h, i]));
  const yi = new Map(yLabels.map((q, i) => [q, i]));
  const got = new Map();
  for (const r of rows || []) {
    const x = xi.get(r.hour), y = yi.get(String(r.id));
    if (x == null || y == null) continue;
    const k = `${x},${y}`;
    got.set(k, (got.get(k) ?? 0) + (Number(r.moves) || 0));   // 同格累加
  }
  const cells = [];
  for (let x = 0; x < xLabels.length; x++) {
    for (let y = 0; y < yLabels.length; y++) {
      const k = `${x},${y}`;
      cells.push({ x: xLabels[x], y: yLabels[y], v: got.has(k) ? got.get(k) : null });
    }
  }
  return cells;
}


/**
 * 构建岸桥色块图横轴标签：最近 hours 个整点
 * @param hours 时段数（含当前小时）
 * @param now   基准时刻 epoch ms
 * @returns {string[]} 'ddHH'，升序
 */
function buildQcHeatLabels(hours, now = Date.now()) {
  const d = new Date(now), p = n => String(n).padStart(2, '0');
  d.setMinutes(0, 0, 0);
  // d.setHours(d.getHours() - 1);                     // 最后一格 = 刚结束的小时
  return Array.from({ length: hours }, (_, i) => {
    const t = new Date(d.getTime() - (hours - 1 - i) * 3600000);
    return `${p(t.getDate())}${p(t.getHours())}`;   // 'ddHH'
  });
}


/* ============================================================
   颜色与配置工厂
   ============================================================ */

/** 从 CSS 读取颜色 */
function chartColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    bar20:    s.getPropertyValue('--chart-20').trim() || '#60a5fa',
    bar40:    s.getPropertyValue('--chart-40').trim() || '#34d399',
    bar20Txt: s.getPropertyValue('--chart-20-text').trim() || '#93c5fd',
    bar40Txt: s.getPropertyValue('--chart-40-text').trim() || '#6ee7b7',
    text:     s.getPropertyValue('--c-text').trim() || '#e6edf3',
    soft:     s.getPropertyValue('--c-soft').trim() || '#b0b8c0',
    dim:      s.getPropertyValue('--c-dim').trim() || '#8b949e',
    grid:     s.getPropertyValue('--c-border').trim() || '#30363d',
    /* 船舶详情 */
    ship:        s.getPropertyValue('--chart-ship').trim()          || '#4cc2ff',
    shipBg:      s.getPropertyValue('--chart-ship-bg').trim()       || 'rgba(76,194,255,.15)',
    ref:         s.getPropertyValue('--chart-ref').trim()           || '#ffd04c',
    refBand:     s.getPropertyValue('--chart-ref-band').trim()      || 'rgba(139,148,158,.75)',
    /* 数据标签底色 */
    chip:        s.getPropertyValue('--chart-chip').trim()          || 'rgba(13,17,23,.75)',
    /* 色块图 */
    heatNull:    s.getPropertyValue('--chart-heat-null').trim()     || 'rgba(255,255,255,.03)',
    heatGap:     s.getPropertyValue('--chart-heat-gap').trim()      || 'rgba(255,255,255,.09)',
    heatOnDark:  s.getPropertyValue('--chart-heat-on-dark').trim()  || '#e6edf3',
    heatOnLight: s.getPropertyValue('--chart-heat-on-light').trim() || '#0d1117',
  };
}

/**
 * 按当前主题解析色阶配置
 * config.json 的 qc_move_heat.light 为亮色覆盖（colors / darkFrom）
 */
function heatPalette(cfg) {
  if (!cfg) return {};
  const light = document.documentElement.dataset.theme === 'light';
  return (light && cfg.light) ? { ...cfg, ...cfg.light } : cfg;
}

/** 线性插值两个 #rrggbb */
function mixHex(a, b, t) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  const m = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${m(r1, r2)}${m(g1, g2)}${m(b1, b2)}`;
}

/**
 * move 值 → 色阶颜色（配置分档）
 * @param v   吊数；null 表示该时段无数据
 * @param cfg config.json 的 qc_move_heat（breaks / colors），需先过 heatPalette()
 * @param c   可选，chartColors() 结果；不传则现场读取
 * @returns {{ color: string, step: number }} step 为档位序号，-1 = 无数据
 */
function qcHeatScale(v, cfg, c) {
  const cc     = c ?? chartColors();
  const breaks = cfg?.breaks ?? [];
  const colors = cfg?.colors ?? [];
  if (v == null || !breaks.length) return { color: cc.heatNull, step: -1 };
  if (v <= breaks[0]) return { color: colors[0] ?? '#3f4a5b', step: 0 };

  let i = 1;
  while (i < breaks.length - 1 && v >= breaks[i + 1]) i++;

  const lo  = breaks[i];
  const hi  = breaks[i + 1];
  const cur = colors[i] ?? colors[colors.length - 1];
  const nxt = colors[i + 1];
  if (hi == null || !nxt) return { color: cur, step: i };   // 末段：颜色恒定

  const t = Math.min(1, (v - lo) / (hi - lo));
  return { color: mixHex(cur, nxt, t), step: i };
}

/** 设备作业量柱状图 options */
function deviceChartOptions(c) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400 },
    plugins: {
      legend: {
        position: 'top',
        align: 'end',
        labels: {
          color: c.soft,
          font: { size: 14 },
          padding: 6,
          boxWidth: 14,
          boxHeight: 14,
          usePointStyle: false,
        },
      },
    },
    scales: {
      x: {
        stacked: true,
        ticks: {
          color: c.text,
          font: { family: "'Segoe UI'", size: 16, weight: 'bold' },
        },
        grid: { display: false },
      },
      y: {
        stacked: true,
        ticks: {
          color: c.soft,
          font: { family: "'Segoe UI'", size: 13, weight: 'bold' },
        },
        grid: { color: c.grid },
        beginAtZero: true,
      },
    },
  };
}

/** 设备作业量柱状图 datasets（空数据模板） */
function deviceChartDatasets(c) {
  /** 数据标签 */
  const chip = {
    font: { family: "'Segoe UI'", size: 13, weight: 'bold' },
    backgroundColor: c.chip,
    borderRadius: 4,
    padding: { top: 3, right: 5, bottom: 3, left: 5 },
  };
  const base = { anchor: 'end', align: 'top', offset: 6, ...chip };
  const onlyPos = v => ((v ?? 0) > 0 ? v : null);

  return [
    { label: '20尺', data: [], backgroundColor: c.bar20,
      borderRadius: 4, maxBarThickness: 32,
      datalabels: {
        ...base,
        color: c.bar20Txt,
        display: (ctx) => ctx.chart.getDatasetMeta(1).hidden,
        formatter: onlyPos,
      },
    },
    { label: '40尺', data: [], backgroundColor: c.bar40,
      borderRadius: 4, maxBarThickness: 32,
      datalabels: {
        ...base,
        labels: {
          v20: {
            ...chip,
            color: c.bar20Txt,
            formatter: (v, ctx) => {
              if (ctx.chart.getDatasetMeta(0).hidden) return null;
              const v20 = ctx.chart.data.datasets[0].data[ctx.dataIndex] ?? 0;
              return v20 > 0 ? v20 : null;
            },
          },
          v40: {
            ...chip,
            color: c.bar40Txt,
            offset: (ctx) => ctx.chart.getDatasetMeta(0).hidden ? 6 : 30,
            formatter: onlyPos,
          },
        },
      },
    },
  ];
}

/** 船舶详情折线 options */
function shipDetailOptions(c) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: {
      legend: { labels: { color: c.soft, font: { size: 13 }, boxWidth: 30, boxHeight: 14 } },
      datalabels: { display: false },          // 关掉全局注册的数据标签
    },
    scales: {
      x: { ticks: { color: c.soft, maxTicksLimit: 10, autoSkip: true },
           grid: { color: c.grid } },
      y: { beginAtZero: true, ticks: { color: c.soft }, grid: { color: c.grid },
           title: { display: true, text: '累计作业箱量', color: c.soft } },
    },
  };
}

/** 船舶详情折线 datasets */
function shipDetailDatasets(built, c, refLabel) {
  const band = {
    borderColor: c.refBand,
    borderDash: [6, 4], pointRadius: 0, fill: false, borderWidth: 1,
  };
  return [
    { label: '实际完成(合计)', data: built.actual, borderColor: c.ship,
      backgroundColor: c.shipBg, fill: true, spanGaps: true,
      pointRadius: 1.5, tension: 0.25, borderWidth: 2 },
    { label: refLabel, data: built.ref, borderColor: c.ref,
      borderDash: [6, 4], pointRadius: 0, fill: false, borderWidth: 1.5 },
    { ...band, label: `−1h`, data: built.refEarly },
    { ...band, label: `+1h`, data: built.refLate },
  ];
}

/** 岸桥色块图 options */
function qcHeatOptions(c, cfg, xLabels, yLabels) {
  const MAX_CELL_H = 40;    // 单元格最大高度（px）
  const GAP_X      = 6;     // 列间隙
  const GAP_Y      = 8;     // 行间隙

  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        displayColors: false,
        callbacks: {
          title: it => `岸桥 ${it[0].raw.y}`,
          label: it => {
            const hh = `${String(it.raw.x).slice(2, 4)}:00`;
            return it.raw.v == null ? `${hh}　无数据`
                                    : `${hh}　${it.raw.v} ${cfg?.unit || ''}`;
          },
        },
      },
      datalabels: {
        font: { size: 14, weight: 'bold' },
        formatter: v => (v.v ?? 0) > 0 ? v.v : '',
        display: ctx => (ctx.dataset.data[ctx.dataIndex]?.v ?? 0) > 0,
        // 深色格用浅字、浅色格用深字
        color: ctx => (qcHeatScale(ctx.dataset.data[ctx.dataIndex].v, cfg, c).step >= (cfg?.darkFrom ?? 3)
          ? c.heatOnLight : c.heatOnDark),
      },
    },
    scales: {
      x: { type: 'category', offset: true, labels: xLabels,
           ticks: { color: c.soft, maxRotation: 0, autoSkip: true,
                    callback: function (v) {              // 键 'ddHH' → 'HH:00'
                      return `${String(this.getLabelForValue(v)).slice(2, 4)}:00`;
                    } },
           grid: { display: false } },
      y: { type: 'category', offset: true, labels: yLabels, reverse: false,
           ticks: { color: c.text, font: { size: 13, weight: 'bold' } },
           grid: { display: false } },
    },
    elements: {
      matrix: {
        borderWidth: 1,
        borderColor: c.heatGap,
        borderRadius: 3,
        width:  ({ chart }) => ((chart.chartArea?.width ?? 0) /
                  Math.max(1, chart.options.scales.x.labels?.length || 0)) - GAP_X,
        height: ({ chart }) => Math.max(0,
                  Math.min((chart.chartArea?.height ?? 0) /
                  Math.max(1, chart.options.scales.y.labels?.length || 0),
                  MAX_CELL_H) - GAP_Y),
      },
    },
  };
}


/* ============================================================
   Charts - 图表实例管理
   ============================================================ */

const Charts = {
  deviceCharts: {},      // 设备作业量柱状图（chart-rtg/qc/fl）
  shipDetailCharts: {},  // 船舶详情折线图（sd-chart）
  qcHeatCharts: {},      // 岸桥 move 色块图（qd-chart）

  init() {
    Chart.register(ChartDataLabels);
    this.initDeviceCharts();
  },

  /** 创建三张设备作业量柱状图 */
  initDeviceCharts() {
    const c = chartColors();
    ['chart-rtg', 'chart-qc', 'chart-fl'].forEach(id => {
      const ctx = document.getElementById(id)?.getContext('2d');
      if (!ctx) return;
      this.deviceCharts[id] = new Chart(ctx, {
        type: 'bar',
        data: { labels: [], datasets: deviceChartDatasets(c) },
        options: deviceChartOptions(c),
      });
    });
  },

  /**
   * 主题切换后重建全部图表
   * 用各实例已有的数据源（State）重建，避免到处写"逐字段刷颜色"的代码。
   */
  refreshTheme() {
    for (const ch of [...Object.values(this.deviceCharts),
                      ...Object.values(this.shipDetailCharts),
                      ...Object.values(this.qcHeatCharts)]) {
      ch.destroy();
    }
    this.deviceCharts = {};
    this.shipDetailCharts = {};
    this.qcHeatCharts = {};

    this.initDeviceCharts();
    this.updateDeviceChart('chart-rtg', filterByConfig(State.getByType('2'), 'rtg'));
    this.updateDeviceChart('chart-fl',  filterByConfig(State.getByType('3'), 'fl'));
    this.updateDeviceChart('chart-qc',  filterByConfig(State.getByType('1'), 'qc'));
    this.syncDeviceAxis();          // 新实例没有 suggestedMax，不重新统一会有刻度跳变
    DetailPanel.refresh();          // 详情面板已展开则重画；未展开为空操作
  },

  /** 更新指定设备作业量柱状图 @param {'chart-rtg'|'chart-qc'|'chart-fl'} chartId */
  updateDeviceChart(chartId, data) {
    const chart = this.deviceCharts[chartId];
    if (!chart) return;

    const { labels, d20, d40 } = buildDeviceChartData(data);
    chart.data.labels = labels;
    chart.data.datasets[0].data = d20;
    chart.data.datasets[1].data = d40;
    chart.update('none');
  },

  /** 统一设备作业量柱状图的纵坐标刻度 */
  syncDeviceAxis() {
    let max = 0;

    for (const chart of Object.values(this.deviceCharts)) {
      if (!chart.data.labels.length) continue;
      for (let i = 0; i < chart.data.labels.length; i++) {
        let stacked = 0;
        for (const ds of chart.data.datasets) {
          stacked += (ds.data[i] ?? 0);
        }
        if (stacked > max) max = stacked;
      }
    }

    max = Math.ceil(max * 1.05);

    for (const chart of Object.values(this.deviceCharts)) {
      chart.config.options.scales.y.suggestedMax = max;
      chart.update();
    }
  },

  /** 更新设备作业量图表头部总计 */
  updateDeviceSummaries() {
    const map = {
      'summary-rtg': filterByConfig(State.getByType('2'), 'rtg'),
      'summary-qc':  filterByConfig(State.getByType('1'), 'qc'),
      'summary-fl':  filterByConfig(State.getByType('3'), 'fl'),
    };

    for (const [id, list] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (!el) continue;

      const s20 = list.reduce((s, d) => s + (Number(d.day_20) || 0), 0);
      const s40 = list.reduce((s, d) => s + (Number(d.day_40) || 0), 0);
      const nat = s20 + s40;
      const teu = s20 + s40 * 2;

      el.innerHTML = `
        <span class="cs-item cs-20"><span class="cs-label">20尺</span><span class="cs-val">${s20}</span></span>
        <span class="cs-item cs-40"><span class="cs-label">40尺</span><span class="cs-val">${s40}</span></span>
        <span class="cs-item cs-nat"><span class="cs-label">自然箱</span><span class="cs-val">${nat}</span></span>
        <span class="cs-item cs-teu"><span class="cs-label">TEU</span><span class="cs-val">${teu}</span></span>`;
    }
  },

  /** 更新设备作业量图表标题 当日/当班 前缀 */
  updateDeviceTitles() {
    const shift = State.statsMode === 'shift';
    document.querySelectorAll('.chart-title .ct-mode').forEach(el => {
      el.textContent = shift ? '当班' : '当日';
    });
  },

  /** 船舶详情折线：有实例则增量更新，否则创建 */
  renderShipDetail(canvasId, { points, plan, t0, dur }) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const built    = buildShipDetailData(points, plan, t0, dur);
    const refLabel = `作业进度参考(${dur}h)`;
    let chart = this.shipDetailCharts[canvasId];

    if (chart) {
      chart.data.labels            = built.labels;
      chart.data.datasets[0].data  = built.actual;
      chart.data.datasets[1].data  = built.ref;
      chart.data.datasets[1].label = refLabel;
      chart.data.datasets[2].data  = built.refEarly;
      chart.data.datasets[2].label = `−1h`;
      chart.data.datasets[3].data  = built.refLate;
      chart.data.datasets[3].label = `+1h`;
      chart.update('none');
      return chart;
    }

    const c = chartColors();
    chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: built.labels, datasets: shipDetailDatasets(built, c, refLabel) },
      options: shipDetailOptions(c),
    });
    this.shipDetailCharts[canvasId] = chart;
    return chart;
  },

  /** 面板显示后调用：修正隐藏期间算出的 0 尺寸 */
  resizeShipDetail(canvasId) { this.shipDetailCharts[canvasId]?.resize(); },

  /** 彻底移除 */
  destroyShipDetail(canvasId) {
    const chart = this.shipDetailCharts[canvasId];
    if (chart) { chart.destroy(); delete this.shipDetailCharts[canvasId]; }
  },

  /** 岸桥色块图：有实例则原位更新，否则创建 */
  renderQcHeat(canvasId, { rows, yLabels }) {
    const cfg     = heatPalette(Config.data?.qc_move_heat);   // 亮/暗色阶
    const xLabels = buildQcHeatLabels(cfg.hours ?? 12);
    const yIds    = yLabels ?? [];
    const cells   = buildQcHeatData(rows, xLabels, yIds);
    const cc      = chartColors();                            // 闭包复用，避免逐格 getComputedStyle

    let chart = this.qcHeatCharts[canvasId];
    if (chart) {
      chart.options.scales.x.labels = xLabels;
      chart.options.scales.y.labels = yIds;
      chart.data.datasets[0].data = cells;
      chart.data.datasets[0].backgroundColor = d => qcHeatScale(d.raw.v, cfg, cc).color;
      chart.update('none');
      return chart;
    }

    const canvas = document.getElementById(canvasId);
    if (!canvas || !yIds.length) return null;
    chart = new Chart(canvas.getContext('2d'), {
      type: 'matrix',
      data: {
        datasets: [{
          data: cells,
          backgroundColor: d => qcHeatScale(d.raw.v, cfg, cc).color,
        }],
      },
      options: qcHeatOptions(cc, cfg, xLabels, yIds),
    });
    this.qcHeatCharts[canvasId] = chart;
    return chart;
  },

  resizeQcHeat(canvasId) { this.qcHeatCharts[canvasId]?.resize(); },

  destroyQcHeat(canvasId) {
    const chart = this.qcHeatCharts[canvasId];
    if (chart) { chart.destroy(); delete this.qcHeatCharts[canvasId]; }
  },

  /** 生成色阶条渐变 */
  syncQcLegend() {
    const cfg = heatPalette(Config.data?.qc_move_heat);
    const bar = document.getElementById('qd-legend-bar');
    if (!cfg || !bar) return;
    bar.style.background = `linear-gradient(90deg, ${(cfg.colors || []).slice(1).join(',')})`;
    const mx = document.getElementById('qd-legend-max');
    if (mx) mx.textContent = `${(cfg.breaks || []).at(-1)}+`;
  },
};