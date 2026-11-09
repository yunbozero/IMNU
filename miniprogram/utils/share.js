/**
 * 分享文案。四个页面共用，改一次就全变。
 *
 * ★ 分享不需要微信认证 —— 它是基础能力，加上 onShareAppMessage 就有。
 *   （认证影响的是「被搜一搜收录」，两件事别混。）
 * ★ 文案里不写任何买卖类口径，和界面上的合规措辞保持一致：
 *   测试会把这里的字也扫一遍，多写一个买卖类词就红。
 */

export const APP_NAME = '盛师猫猫';

/** 首页 / 图鉴列表这种「整站」分享 */
export function shareHome() {
  return {
    title: `${APP_NAME} · 看看有什么`,
    path: '/pages/home/index',
  };
}

export function shareCats() {
  return {
    title: `${APP_NAME} · 校园猫咪图鉴`,
    path: '/pages/cats/index',
  };
}

/** 单个物品：带 id 分享出去，对方点开直达那一件 */
export function shareItem(item) {
  const name = (item && item.name) || '一件物品';
  return {
    title: `${name} · ${APP_NAME}`,
    path: `/packageBazaar/pages/detail/index?id=${encodeURIComponent((item && item.id) || '')}`,
  };
}

/** 单只猫 */
export function shareCat(cat) {
  const name = (cat && cat.name) || '一只猫';
  return {
    title: `${name} · ${APP_NAME} 图鉴`,
    path: `/packageCats/pages/detail/index?id=${encodeURIComponent((cat && cat.id) || '')}`,
  };
}

/**
 * 朋友圈分享（onShareTimeline）。
 * 用法：页面里 `onShareTimeline() { return timeline(this.data.item); }`
 * 只接受 { title, query }，query 是**不带问号**的参数字符串。
 */
export function timeline(obj) {
  const id = obj && obj.id ? encodeURIComponent(obj.id) : '';
  return {
    title: obj && obj.name ? `${obj.name} · ${APP_NAME}` : APP_NAME,
    query: id ? `id=${id}` : '',
  };
}
