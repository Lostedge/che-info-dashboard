/**
 * Chart.js 图表模块
 * 依赖: Chart 全局 (chart.umd.min.js)
 */

/** 数据标签 */
const Labels = {
  id: 'labels',
  afterDatasetsDraw(chart) {
    const { ctx, data } = chart;
    const top = chart.getDatasetMeta(1);
    if (!top.visible || !top.data.length) return;

    const c20 = data.datasets[0].backgroundColor;
    const c40 = data.datasets[1].backgroundColor;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.font = "bold 13px 'Segoe UI'";
    const lineH = 24;

    top.data.forEach((el, i) => {
      const v20 = data.datasets[0].data[i] ?? 0;
      const v40 = data.datasets[1].data[i] ?? 0;
      if (!v20 && !v40) return;

      const x = el.x;
      let y = el.y - 6;
      if (v20 > 0) { this._chip(ctx, String(v20), c20, x, y); y -= lineH; }
      if (v40 > 0) { this._chip(ctx, String(v40), c40, x, y); y -= lineH; }
    });

    ctx.restore();
  },

  _chip(ctx, text, color, x, y) {
    const padX = 5, padY = 3, r = 4;
    const fontSize = 13;
    const w = ctx.measureText(text).width + padX * 2;
    const h = fontSize + padY * 2;
    const cx = x - w / 2;
    const cy = y - h + 2;

    ctx.beginPath();
    ctx.moveTo(cx + r, cy);
    ctx.arcTo(cx + w, cy, cx + w, cy + h, r);
    ctx.arcTo(cx + w, cy + h, cx, cy + h, r);
    ctx.arcTo(cx, cy + h, cx, cy, r);
    ctx.arcTo(cx, cy, cx + w, cy, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(13, 17, 23, 0.75)';
    ctx.fill();

    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  },
};


const Charts = {
  instances: {},

  /** 从 CSS 读取颜色 */
  getColors() {
    const s = getComputedStyle(document.documentElement);
    return {
      bar20: s.getPropertyValue('--chart-20').trim() || '#60a5fa',
      bar40: s.getPropertyValue('--chart-40').trim() || '#34d399',
      text:  s.getPropertyValue('--c-text').trim() || '#e6edf3',
      soft:  s.getPropertyValue('--c-soft').trim() || '#b0b8c0',
      dim:   s.getPropertyValue('--c-dim').trim() || '#8b949e',
      grid:  s.getPropertyValue('--c-border').trim() || '#30363d',
    };
  },

  init() {
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

    ['chart-rtg', 'chart-qc', 'chart-fl'].forEach(id => {
      const ctx = document.getElementById(id)?.getContext('2d');
      if (!ctx) return;
      this.instances[id] = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: [],
          datasets: [
            { label: '20尺', data: [], backgroundColor: c.bar20,
              borderRadius: 4, maxBarThickness: 32 },
            { label: '40尺', data: [], backgroundColor: c.bar40,
              borderRadius: 4, maxBarThickness: 32 },
          ],
        },
        options: baseOpts,
        plugins: [Labels],
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