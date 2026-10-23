/**
 * 可改文案（服务端下发，改完不用发版）。
 *
 * 规则：
 *   · **一定有默认值**：`DEFAULTS` 就是现在线下那套字，拉不到接口、第一次打开、
 *     接口挂了 —— 都照常显示。文案服务端化最怕的就是「网差时首页空一片」。
 *   · 拉到的只覆盖白名单里的 key，其余保持默认。
 *   · 缓存 30 分钟：这类文字一天也不会变几次，不用每次进页面都拉。
 */
import * as api from './api.js';
import { FEEDING_TIPS } from '../data/cats.js';

const STORAGE_KEY = 'copy.v1';
const TTL_MS = 30 * 60 * 1000;

/** 和服务端 COPY_DEFAULTS 一致 —— 有测试比对，别只改一边 */
export const DEFAULTS = {
  catTips: {
    title: '校园喂养提示',
    items: FEEDING_TIPS,
  },
};

function readCache() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY);
    if (raw && typeof raw.at === 'number' && Date.now() - raw.at < TTL_MS) return raw.copy;
  } catch { /* storage 坏了就当没有 */ }
  return null;
}

function writeCache(copy) {
  try { wx.setStorageSync(STORAGE_KEY, { at: Date.now(), copy }); } catch { /* 存不下就算了 */ }
}

/** 当前可用的文案：缓存优先，没有就默认。**同步**，页面 onLoad 直接用。 */
export function current() {
  return { ...DEFAULTS, ...(readCache() || {}) };
}

/**
 * 从服务端刷新一次。失败就返回当前值 —— 文案拉不到不该影响任何功能。
 * @returns {Promise<object>} 合并后的文案
 */
export async function refresh() {
  try {
    const r = await api.get('/api/copy');
    const copy = (r && r.copy) || {};
    const merged = { ...DEFAULTS, ...copy };
    writeCache(merged);
    return merged;
  } catch {
    return current();
  }
}

/** 图鉴列表底部那张「喂养提示」卡片 */
export function catTips(copy = current()) {
  const t = copy && copy.catTips;
  const fallback = DEFAULTS.catTips;
  if (!t || !t.title || !Array.isArray(t.items) || !t.items.length) return fallback;

  // ★ 颜色（tone）不是文案，不进服务端：按行号跟着默认那套走，
  //   最后一行是「推荐」= 绿色，其余 = 提醒色。管理员只改字，不改配色。
  const items = t.items.map((it, i) => ({
    label: it.label,
    text: it.text,
    tone: (fallback.items[i] && fallback.items[i].tone)
      || (i === t.items.length - 1 ? 'ok' : 'warn'),
  }));
  return { title: t.title, items };
}
