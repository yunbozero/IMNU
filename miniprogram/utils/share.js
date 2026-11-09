/**
 * 分享文案。四个页面共用，改一次就全变。
 *
 * ★ 分享不需要微信认证 —— 它是基础能力，加上 onShareAppMessage 就有。
 *   （认证影响的是「被搜一搜收录」，两件事别混。）
 * ★ 文案里不写任何买卖类口径，和界面上的合规措辞保持一致：
 *   测试会把这里的字也扫一遍，多写一个买卖类词就红。
 */

export const APP_NAME = '盛师猫猫';

import { imageUrl } from './format.js';

/**
 * 卡片图。
 *
 * 不传 imageUrl 时微信会**自动截当前页面**当卡片图（裁成 5:4），
 * 经常截到公告条或者大片空白。所以物品/猫的分享都尽量带上它自己的照片。
 * 拿不到照片时返回空串 —— 那就让微信去截图，总不能因为没图就不让分享。
 */
function cardImage(obj) {
  if (!obj) return '';
  if (obj.imageUrl) return obj.imageUrl;           // 页面已经算好的直接用
  if (obj.image) return imageUrl({ image: obj.image });
  return '';
}

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

/** 单个物品：带 id 分享出去，对方点开直达那一件；卡片图用物品照片 */
export function shareItem(item) {
  const name = (item && item.name) || '一件物品';
  const image = cardImage(item);
  return {
    title: `${name} · ${APP_NAME}`,
    path: `/packageBazaar/pages/detail/index?id=${encodeURIComponent((item && item.id) || '')}`,
    ...(image ? { imageUrl: image } : {}),
  };
}

/** 单只猫 */
export function shareCat(cat) {
  const name = (cat && cat.name) || '一只猫';
  const image = cardImage(cat);
  return {
    title: `${name} · ${APP_NAME} 图鉴`,
    path: `/packageCats/pages/detail/index?id=${encodeURIComponent((cat && cat.id) || '')}`,
    ...(image ? { imageUrl: image } : {}),
  };
}

/**
 * 朋友圈分享（onShareTimeline）。
 * 用法：页面里 `onShareTimeline() { return timeline(this.data.item); }`
 * 只接受 { title, query, imageUrl }，query 是**不带问号**的参数字符串。
 *
 * ★ 朋友圈是**看图**的地方，配图比标题重要得多 —— 这里和聊天卡片共用同一套取图逻辑。
 */
export function timeline(obj) {
  const id = obj && obj.id ? encodeURIComponent(obj.id) : '';
  const image = cardImage(obj);
  return {
    title: obj && obj.name ? `${obj.name} · ${APP_NAME}` : APP_NAME,
    query: id ? `id=${id}` : '',
    ...(image ? { imageUrl: image } : {}),
  };
}
