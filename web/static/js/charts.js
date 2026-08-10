/**
 * Chart.js 图表模块
 * 依赖: Chart 全局 (chart.umd.min.js)
 */


const Charts = {
  instances: {},

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