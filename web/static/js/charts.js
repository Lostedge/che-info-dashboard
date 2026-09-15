/**
 * Chart.js 图表模块
 * 依赖: Chart 全局 (chart.umd.min.js)
 */


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
  const durMs = (Number(dur) || 0) * 3600 * 1000;
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

  // 参考直线：start → end，0 → plan
  const hasRef = plan > 0 && durMs > 0;
  const ref = times.map(t =>
    (hasRef && t >= start && t <= end) ? plan * ((t - start) / durMs) : null);

  return { labels: times.map(fmtMMDDHHmm), actual, ref };
}


const Charts = {
  instances: {},   // 作业量柱状图（chart-rtg/qc/fl）
  detail: {},      // 详情折线图（sd-chart），单独存放，避免被 syncYAxis 干扰

  /** 从 CSS 读取颜色 */
  getColors() {
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
    };
  },

  init() {
    Chart.register(ChartDataLabels);
    const c = this.getColors();

    const baseOpts = {
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

    /** 数据标签 */
    const chip = {
      font: { family: "'Segoe UI'", size: 13, weight: 'bold' },
      backgroundColor: 'rgba(13, 17, 23, 0.75)',
      borderRadius: 4,
      padding: { top: 3, right: 5, bottom: 3, left: 5 },
    };
    const base = { anchor: 'end', align: 'top', offset: 6, ...chip };
    const onlyPos = v => ((v ?? 0) > 0 ? v : null);

    /** 数据集配置 */
    const makeDatasets = () => [
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

    ['chart-rtg', 'chart-qc', 'chart-fl'].forEach(id => {
      const ctx = document.getElementById(id)?.getContext('2d');
      if (!ctx) return;
      this.instances[id] = new Chart(ctx, {
        type: 'bar',
        data: { labels: [], datasets: makeDatasets() },
        options: baseOpts,
      });
    });
  },

  /** @param {'chart-rtg'|'chart-qc'|'chart-fl'} chartId */
  update(chartId, data) {
    const chart = this.instances[chartId];
    if (!chart) return;

    const list = (data || []).sort((a, b) => a.id.localeCompare(b.id));
    chart.data.labels = list.map(d => d.id);
    chart.data.datasets[0].data = list.map(d => d.day_20 ?? 0);
    chart.data.datasets[1].data = list.map(d => d.day_40 ?? 0);
    chart.update('none');
  },

  /** 统一图表的纵坐标刻度 */
  syncYAxis() {
    let max = 0;

    for (const chart of Object.values(this.instances)) {
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

    for (const chart of Object.values(this.instances)) {
      chart.config.options.scales.y.suggestedMax = max;
      chart.update();
    }
  },

  /** 更新所有 chart-header 总计 */
  updateSummaries() {
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

  /** 更新标题 当日/当班 前缀 */
  updateTitles() {
    const shift = State.statsMode === 'shift';
    document.querySelectorAll('.chart-title .ct-mode').forEach(el => {
      el.textContent = shift ? '当班' : '当日';
    });
  },

  /** 船舶详情折线：有实例则增量更新 */
  shipDetail(canvasId, { points, plan, t0, dur }) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const built    = buildShipDetailData(points, plan, t0, dur);
    const refLabel = `作业进度参考(${dur}h)`;
    let chart = this.detail[canvasId];

    if (chart) {
      chart.data.labels             = built.labels;
      chart.data.datasets[0].data   = built.actual;
      chart.data.datasets[1].data   = built.ref;
      chart.data.datasets[1].label  = refLabel;
      chart.update('none');
      return chart;
    }

    const c = this.getColors();
    chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: built.labels,
        datasets: [
          { label: '实际完成(合计)', data: built.actual, borderColor: '#4cc2ff',
            backgroundColor: 'rgba(76,194,255,.15)', fill: true, spanGaps: true,
            pointRadius: 1.5, tension: 0.25, borderWidth: 2 },
          { label: refLabel, data: built.ref, borderColor: '#ffd04c',
            borderDash: [6, 4], pointRadius: 0, fill: false, borderWidth: 1.5 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { labels: { color: c.soft, font: { size: 13 }, boxWidth: 14, boxHeight: 14 } },
          datalabels: { display: false },          // 关掉全局注册的数据标签
        },
        scales: {
          x: { ticks: { color: c.soft, maxTicksLimit: 10, autoSkip: true },
               grid: { color: c.grid } },
          y: { beginAtZero: true, ticks: { color: c.soft }, grid: { color: c.grid },
               title: { display: true, text: '累计作业箱量', color: c.dim } },
        },
      },
    });
    this.detail[canvasId] = chart;
    return chart;
  },

  /** 面板显示后调用：修正隐藏期间算出的 0 尺寸 */
  shipDetailResize(canvasId) { this.detail[canvasId]?.resize(); },

  /** 彻底移除 */
  shipDetailRemove(canvasId) {
    const chart = this.detail[canvasId];
    if (chart) { chart.destroy(); delete this.detail[canvasId]; }
  },
};