/**
 * 图鉴照片：把「管理员在小程序里换的照片」和「仓库里那张默认照片」合起来。
 *
 * 为什么要合并，而不是二选一：
 *   · 仓库里的 `assets/cats/xxx.jpg` 是**兜底** —— 新库、新服务器上线时图鉴首屏
 *     就有照片，而且照片在 git 里有版本、跟着备份走，不用怕丢；
 *   · 数据库里的覆盖是**临时换图** —— 拍到新照片想马上替换，不用发版。
 * 优先级只有一条：**有覆盖用覆盖，没有就用仓库那张。**
 *
 * ------------------------------------------------------------------
 * 为什么带本地缓存
 * ------------------------------------------------------------------
 * 图鉴是 tabBar 上的一级页面，原来**一个网络请求都不发**，断网也能看（回落 emoji）。
 * 加了覆盖之后它要发一次请求 —— 如果只在请求回来之后才显示照片，
 * 那首屏会先空一下，而且断网时明明有仓库那张也不显示了，等于把原来的优点弄丢。
 *
 * 所以这里的做法是：
 *   1. `cached()` 先同步拿出**上一次成功拿到的**覆盖表 → 首屏立刻就有图；
 *   2. 再异步 `fetch()` 一次，回来之后刷新。
 * 请求失败就什么都不改，继续用缓存 / 仓库那张。全程没有加载态，也不会报错。
 *
 * 缓存本身坏掉（有人手改、版本对不上）一律当成「没有缓存」，不抛错 ——
 * 这个文件里的任何失败都不该让图鉴页白屏。
 */
import * as api from './api.js';
import { platform } from './platform.js';
import { imageUrl } from '../utils/format.js';

/**
 * 本地缓存键。改结构时换一个，别去读旧格式。
 * 和 session.js 一样走 platform()，所以这个模块在 Node 里也能直接测。
 */
export const STORAGE_KEY = 'catPhotos.v1';

/** 只保留「id → 文件名」这种形状的键值，别的一律丢掉。 */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === 'string' && k && typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

/** 上一次成功拿到的覆盖表。读不到、格式不对都返回空对象。 */
export function cached() {
  return sanitize(platform().getStorage(STORAGE_KEY));
}

function save(photos) {
  // platform() 内部已经吞掉了「存储满了 / 被禁用」的异常
  platform().setStorage(STORAGE_KEY, photos);
}

/**
 * 拉一次覆盖表。
 *
 * @returns {Promise<object|null>} 成功返回 id → 文件名（可能是空对象）；
 *   **失败返回 null** —— 调用方靠它区分「服务端说没有覆盖」和「这次没问到」，
 *   后者不该覆盖掉已有的缓存。
 */
export async function fetch() {
  try {
    const r = await api.get('/api/cat-photos');
    const photos = sanitize(r && r.photos);
    save(photos);
    return photos;
  } catch {
    return null;
  }
}

/**
 * 覆盖值得**看起来像个文件名**才用。
 *
 * 这不是安全校验（路径穿越在服务端就已经不可能了），而是防**本地存储坏掉**：
 * 缓存内容被手改过、或者以后换了格式时，一个对象/数字会被拼进地址变成
 * `/images/[object Object]` —— 请求必然 404，而现象是「照片莫名奇妙没了」，
 * 完全看不出是缓存的问题。
 */
const usableName = (v) =>
  (typeof v === 'string' && v.length > 0 && v.length <= 128 && !/\s/.test(v) ? v : null);

/**
 * 把一只猫的资料补上要显示的照片地址。
 *
 * `photo` 为空字符串表示「没有照片，界面要回落 emoji」——
 * 和物品照片同一个约定（见 utils/format.js 的 imageUrl）。
 */
export function withPhoto(cat, photos) {
  const override = photos && typeof photos === 'object' ? photos[cat.id] : null;
  const name = usableName(override) || usableName(cat.image) || null;
  return { ...cat, photo: imageUrl({ image: name }) };
}
