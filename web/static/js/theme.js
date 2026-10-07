/**
 * 主题初始化
 * ------------------------------------------------------------
 * 必须在首次绘制前执行，否则亮色主题下会先闪一下暗色。
 * 独立成文件的原因：CSP 为 script-src 'self'，不允许内联脚本。
 * 切换逻辑见 dashboard.js 的 Theme 模块。
 */
(function () {
  try {
    var t = localStorage.getItem('theme');
    document.documentElement.dataset.theme = (t === 'light' || t === 'dark') ? t : 'dark';
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';   // localStorage 被禁用时用默认值
  }
})();
