/**
 * Chart.js 图表模块
 * 依赖: Chart 全局 (chart.umd.min.js)
 */

const Charts = {
  instances: {},

  init() {
    const baseOpts = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            color: '#b0b8c0',
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
            color: '#b0b8c0', 
            font: { family: "'Segoe UI'", size: 16, weight: 'bold' },
          },
          grid: { display: false },
        },
        y: {
          stacked: true,
          ticks: { 
            color: '#b0b8c0', 
            font: { family: "'Segoe UI'", size: 13, weight: 'bold' },
          },
          grid: { color: '#30363d' },
          beginAtZero: true,
        },
      },
    };

    ['chart-rtg', 'chart-qc', 'chart-fl'].forEach(id => {
      const ctx = document.getElementById(id)?.getContext('2d');
      if (!ctx) return;
      this.instances[id] = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: [],
          datasets: [
            { label: '20尺', data: [], backgroundColor: '#60a5fa',
              borderRadius: 4, maxBarThickness: 32 },
            { label: '40尺', data: [], backgroundColor: '#34d399',
              borderRadius: 4, maxBarThickness: 32 },
          ],
        },
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