/**
 * 猫猫图鉴的数据来源。
 *
 * 猫的资料存在服务端的 `cats` 表里（原来编译在 `data/cats.js` 里）。
 * 搬进数据库是为了**加猫、改资料、换照片都不用发版** —— 发一次版要等 1–2 天审核，
 * 而图鉴是 tabBar 上的一级页面，内容会一直变。
 *
 * ------------------------------------------------------------------
 * 为什么带本地缓存
 * ------------------------------------------------------------------
 * 图鉴原来是「零网络请求、断网也能看」的页面。改成读接口之后，
 * 如果只在请求回来之后才渲染，首屏会先空一下，断网时更是整个页面什么都没有 ——
 * 那就把原来最大的优点弄丢了。
 *
 * 所以这里的做法是：
 *   1. `cached()` 先同步拿出**上一次成功拿到的**列表 → 首屏立刻就有内容；
 *   2. 再异步 `fetch()` 一次，回来之后刷新。
 * 请求失败就什么都不改，继续用缓存。全程没有加载态，也不会弹错。
 *
 * 缓存坏掉（有人手改、版本对不上、结构变了）一律当成「没有缓存」，不抛错 ——
 * 这个文件里的任何失败都不该让图鉴页白屏。
 */
import * as api from './api.js';
import { platform } from './platform.js';
import { imageUrl } from '../utils/format.js';
import { CAT_STATUS } from '../data/cats.js';

/** 本地缓存键。改结构时换一个，别去读旧格式。 */
export const STORAGE_KEY = 'cats.v1';

/**
 * 只留下界面真正要用的字段，而且 id / name 必须是非空字符串。
 *
 * ★ 要过滤掉坏行而不是整份丢掉：一条坏数据不该让整张图鉴消失。
 *   服务端已经卡过一道，这里防的是**本地存储被改坏**。
 */
function sanitizeList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.id !== 'string' || !c.id) continue;
    if (typeof c.name !== 'string' || !c.name) continue;
    out.push({
      id: c.id,
      name: c.name,
      emoji: typeof c.emoji === 'string' ? c.emoji : '',
      tint: typeof c.tint === 'string' ? c.tint : '',
      image: typeof c.image === 'string' ? c.image : null,
      status: typeof c.status === 'string' ? c.status : '',
      gender: typeof c.gender === 'string' ? c.gender : '',
      location: typeof c.location === 'string' ? c.location : '',
      personality: typeof c.personality === 'string' ? c.personality : '',
      note: typeof c.note === 'string' ? c.note : '',
    });
  }
  return out;
}

/** 上一次成功拿到的列表。读不到、格式不对都返回空数组。 */
export function cached() {
  return sanitizeList(platform().getStorage(STORAGE_KEY));
}

function save(list) {
  // platform() 内部已经吞掉了「存储满了 / 被禁用」的异常
  platform().setStorage(STORAGE_KEY, list);
}

/**
 * 拉一次图鉴。
 *
 * @returns {Promise<Array|null>} 成功返回数组（可能是空的）；
 *   **失败返回 null** —— 调用方靠它区分「服务端说一只猫都没有」和「这次没问到」，
 *   后者不该把界面上已有的内容清空。
 */
export async function fetchCats() {
  try {
    const r = await api.get('/api/cats');
    const list = sanitizeList(r && r.cats);
    save(list);
    return list;
  } catch {
    return null;
  }
}

/**
 * 补上展示用字段。列表页、详情页、管理端都走它 ——
 * 三处各算一遍的话，迟早出现「详情页有照片、列表页没有」这种对不上的状态。
 */
export function decorate(cat) {
  return {
    ...cat,
    photo: imageUrl(cat),
    statusText: CAT_STATUS[cat.status] || '',
  };
}

/** 分组用。status 是服务端存的键。 */
export function byStatus(list, status) {
  return (list || []).filter((c) => c.status === status);
}

export function findById(list, id) {
  return (list || []).find((c) => c.id === id) || null;
}
