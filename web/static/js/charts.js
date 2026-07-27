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
            font: { size: 12 },
            padding: 6,
            boxWidth: 12,
            boxHeight: 12,
            usePointStyle: false,
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: '#8b949e', font: { size: 10 } },
          grid: { display: false },
        },
        y: {
          stacked: true,
          ticks: { color: '#8b949e', font: { size: 10 } },
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
            { label: '20尺', data: [], backgroundColor: '#58a6ff', borderRadius: 2 },
            { label: '40尺', data: [], backgroundColor: '#10b981', borderRadius: 2 },
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
};