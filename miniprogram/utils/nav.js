/**
 * 自定义导航栏的尺寸计算。
 *
 * 为什么需要它：详情页想用「沉浸式大图」——照片顶到屏幕最上面，
 * 标题和返回键浮在图上。这时就不能用微信默认导航栏，得自己画一条，
 * 而自己画就必须知道**状态栏多高、右上角胶囊按钮在哪儿**，
 * 否则标题会被胶囊压住、或者内容顶到刘海里去。
 *
 * ★ 计算部分抽成纯函数：Node 里跑测试时没有 wx，直接调 wx.getMenuButtonBoundingClientRect
 *   会抛。纯函数既能测，也能在真机上取到更准的值。
 */

/** 取不到时的保守值（按常见 iPhone 的 44pt 导航栏算） */
export const NAV_FALLBACK = {
  statusBarHeight: 20,
  contentTop: 28,
  contentHeight: 44,
  navBarHeight: 76,
  menuReserveWidth: 104,
};

/**
 * @param {object} input
 * @param {object} [input.systemInfo]  wx.getSystemInfoSync()
 * @param {object} [input.menuButton]  wx.getMenuButtonBoundingClientRect()
 * @returns {{statusBarHeight:number, contentTop:number, contentHeight:number,
 *            navBarHeight:number, menuReserveWidth:number}}
 */
export function computeNavMetrics({ systemInfo, menuButton } = {}) {
  const statusBarHeight = Number(systemInfo && systemInfo.statusBarHeight)
    || NAV_FALLBACK.statusBarHeight;

  // 取不到胶囊位置：按「状态栏 + 8 + 44」估一个，界面上不至于塌
  if (!menuButton || !menuButton.top || !menuButton.height) {
    const contentTop = statusBarHeight + 8;
    return {
      ...NAV_FALLBACK,
      statusBarHeight,
      contentTop,
      navBarHeight: contentTop + NAV_FALLBACK.contentHeight + 8,
    };
  }

  // 胶囊和状态栏之间的空隙，最少留 6（有的机型两者贴得很近）
  const topGap = Math.max(menuButton.top - statusBarHeight, 6);
  const contentTop = statusBarHeight + topGap;
  const contentHeight = menuButton.height;
  const navBarHeight = contentTop + contentHeight + topGap;

  // 右侧要给胶囊留出的宽度：胶囊宽 + 到右边的距离 + 一点余量
  const windowWidth = Number(systemInfo && systemInfo.windowWidth) || 0;
  const rightGap = Math.max(windowWidth - menuButton.right, 8);
  const menuReserveWidth = menuButton.width + rightGap + 8;

  return { statusBarHeight, contentTop, contentHeight, navBarHeight, menuReserveWidth };
}

/** 真机/模拟器里读一次；没有 wx（Node 测试、或被别处 import）时返回兜底值 */
export function getNavMetrics() {
  try {
    if (typeof wx === 'undefined') return computeNavMetrics({});
    const systemInfo = typeof wx.getSystemInfoSync === 'function' ? wx.getSystemInfoSync() : null;
    const menuButton = typeof wx.getMenuButtonBoundingClientRect === 'function'
      ? wx.getMenuButtonBoundingClientRect()
      : null;
    return computeNavMetrics({ systemInfo, menuButton });
  } catch {
    return computeNavMetrics({});
  }
}
