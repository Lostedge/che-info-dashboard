/**
 * ECharts 图表模块（Chart.js 版对比用）
 * ============================================================
 * 依赖: echarts 全局 (libs/echarts.min.js)
 * 对外 API 与 Chart.js 版一致：init / update / syncYAxis / updateSummaries
 * → dashboard.js 无需改动
 */

const Charts = {
  instances: {},          // id -> echarts 实例
  _max: 0,                // 三张图统一的 y 轴最大值

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
    const c = this.getColors();

    ['chart-rtg', 'chart-qc', 'chart-fl'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;

      const chart = echarts.init(el);
      chart.setOption({
        animationDuration: 400,
        color: [c.bar20, c.bar40],
        grid: { left: 6, right: 6, top: 40, bottom: 4, containLabel: true },
        legend: {
          top: 0, right: 0,
          itemWidth: 14, itemHeight: 14,
          textStyle: { color: c.soft, fontSize: 14 },
        },
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        xAxis: {
          type: 'category',
          data: [],
          axisLabel: { color: c.text, fontSize: 16, fontWeight: 'bold', fontFamily: "'Segoe UI'" },
          axisTick: { show: false },
          axisLine: { show: false },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          min: 0,
          axisLabel: { color: c.soft, fontSize: 13, fontWeight: 'bold', fontFamily: "'Segoe UI'" },
          splitLine: { lineStyle: { color: c.grid } },
        },
        series: [
          { name: '20尺', type: 'bar', stack: 'total', barMaxWidth: 32, data: [],
            itemStyle: { borderRadius: [4, 4, 0, 0] },
            label: { show: true, position: 'top', distance: 4,
                     color: c.bar20Txt, fontWeight: 'bold', fontSize: 13,
                     formatter: p => (p.value > 0 ? p.value : '') } },
          { name: '40尺', type: 'bar', stack: 'total', barMaxWidth: 32, data: [],
            itemStyle: { borderRadius: [4, 4, 0, 0] },
            label: { show: true, position: 'top', distance: 4,
                     color: c.bar40Txt, fontWeight: 'bold', fontSize: 13,
                     formatter: p => (p.value > 0 ? p.value : '') } },
        ],
      });

      this.instances[id] = chart;
    });

    // 布局就绪后校准一次尺寸 + 窗口缩放时跟随
    requestAnimationFrame(() => {
      for (const ch of Object.values(this.instances)) ch.resize();
    });
    window.addEventListener('resize', () => {
      for (const ch of Object.values(this.instances)) ch.resize();
    });
  },

  /** @param {'chart-rtg'|'chart-qc'|'chart-fl'} chartId */
  update(chartId, data) {
    const chart = this.instances[chartId];
    if (!chart) return;

    const list = (data || []).sort((a, b) => a.id.localeCompare(b.id));
    chart.setOption({
      xAxis: { data: list.map(d => d.id) },
      series: [
        { data: list.map(d => d.day_20 ?? 0) },
        { data: list.map(d => d.day_40 ?? 0) },
      ],
    });
  },

  /** 统一三张图的 y 轴最大值 */
  syncYAxis() {
    let max = 0;
    const map = [
      ['chart-rtg', '2'],
      ['chart-qc', '1'],
      ['chart-fl', '3'],
    ];

    for (const [id, prefix] of map) {
      if (!this.instances[id]) continue;
      for (const d of State.getByType(prefix)) {
        max = Math.max(max, (d.day_20 ?? 0) + (d.day_40 ?? 0));
      }
    }

    this._max = Math.ceil(max * 1.2);   // 顶部标签留余量

    for (const id of Object.keys(this.instances)) {
      this.instances[id].setOption({ yAxis: { max: this._max } });
    }
  },

  /** 更新所有 chart-header 总计 */
  updateSummaries() {
    const map = {
      'summary-rtg': State.getByType('2'),
      'summary-qc':  State.getByType('1'),
      'summary-fl':  State.getByType('3'),
    };

    for (const [id, list] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (!el) continue;

      const s20 = list.reduce((s, d) => s + (d.day_20 ?? 0), 0);
      const s40 = list.reduce((s, d) => s + (d.day_40 ?? 0), 0);
      const nat = s20 + s40;
      const teu = s20 + s40 * 2;

      el.innerHTML = `
        <span class="cs-item cs-20"><span class="cs-label">20尺</span><span class="cs-val">${s20}</span></span>
        <span class="cs-item cs-40"><span class="cs-label">40尺</span><span class="cs-val">${s40}</span></span>
        <span class="cs-item cs-nat"><span class="cs-label">自然箱</span><span class="cs-val">${nat}</span></span>
        <span class="cs-item cs-teu"><span class="cs-label">TEU</span><span class="cs-val">${teu}</span></span>`;
    }
  },
};
