/* ============================================================
   微信长图 · 共用脚本
   1. 播种演示状态（与 iframe 同源，共享 localStorage）
   2. 把各屏地址填进 iframe，并处理 __RID__ 占位
   3. 关掉过渡动画、按需展开弹层，让截图不依赖任何定时器
   4. 把页面实际高度写进 DOM，供截图脚本读取
   ============================================================ */
(function () {
  /* ---------- 1. 播种 ---------- */
  BZ.reset();
  BZ.signup('2021123456', '王雨桐');
  const made = BZ.reserve('i1', 1);          // 手作黄油曲奇
  const rid = made.ok ? made.reservation.id : 'r-seed-1';

  /* ---------- 2 + 3. 装配 iframe ---------- */
  document.querySelectorAll('iframe[data-src]').forEach((f) => {
    const url = f.dataset.src.replace('__RID__', rid);
    f.src = url;

    f.addEventListener('load', () => {
      const d = f.contentDocument;
      if (!d) return;                                        // 跨源时静默跳过

      const st = d.createElement('style');
      st.textContent =
        '*{transition:none !important;animation:none !important}' +
        '.demo-hint{display:none !important}';   // 长图里不出现"演示提示"这种脚手架
      d.head.appendChild(st);

      // 直接展开需要展示的弹层，不依赖页面自身的 setTimeout
      const pairs = [
        ['sheet=1', ['sheet-reserve', 'sheet-reserve-mask']],
        ['pad=1', ['sheet-pad', 'sheet-pad-mask']],
      ];
      pairs.forEach(([flag, ids]) => {
        if (url.indexOf(flag) < 0) return;
        ids.forEach((id) => {
          const el = d.getElementById(id);
          if (el) el.classList.add('on');
        });
      });

      // 输码弹层填 3 位，比空键盘更像真实使用中的样子
      if (url.indexOf('pad=1') >= 0) {
        ['4', '8', '2'].forEach((k) => {
          const b = d.querySelector('#keys button[data-k="' + k + '"]');
          if (b) b.click();
        });
      }
    });
  });

  /* ---------- 4. 上报高度 ----------
     同步读取即可：iframe 的尺寸是固定的，父页面高度不依赖它们的内容，
     所以不需要等 load，也就不受任何定时器影响。 */
  const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
  document.documentElement.setAttribute('data-page-height', String(height));
})();
