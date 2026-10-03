/**
 * 纯展示用的格式化函数。都是纯函数，方便单测。
 */
import { BASE_URL } from '../config.js';

/**
 * 取货码位数。
 *
 * ★ 必须只有一处定义：取货码页按它生成二维码，核销台按它校验手输/扫码结果。
 *   两边一旦不一致，扫出来的码就会被判成「不是有效的取货码」。
 */
export const PICKUP_CODE_LEN = 6;

/**
 * 物品照片的完整地址；没有照片时返回空字符串（界面要回落到 emoji）。
 *
 * ★ 用 BASE_URL 在这里拼，而不是让服务端返回完整 URL：
 *   BASE_URL 已经按「跑在哪儿」选好了（模拟器 → 127.0.0.1:3000，真机 → 线上域名），
 *   所以同一份数据在两边都对。让服务端返回完整 URL 的话，它就得知道自己
 *   对外叫什么域名 —— 那是个容易配错、而且**只在真机上暴露**的错。
 */
export function imageUrl(item) {
  const name = item && item.image;
  return name ? `${BASE_URL}/images/${name}` : '';
}

/** '482913' → '482 913'，方便学生口报给志愿者 */
export function groupCode(code) {
  const s = String(code || '');
  return s.length === PICKUP_CODE_LEN ? `${s.slice(0, 3)} ${s.slice(3)}` : s;
}

/** 预定状态 → 给学生看的三个词。不要把内部状态机暴露出去。 */
export const STATUS_TEXT = {
  reserved: '待取货',
  redeemed: '已取货',
  cancelled: '已取消',
};

export const statusText = (status) => STATUS_TEXT[status] || '未知';

/** 状态对应的样式修饰符 */
export const statusClass = (status) => ({
  reserved: 'tag',
  redeemed: 'tag tag--green',
  cancelled: 'tag tag--grey',
}[status] || 'tag tag--grey');

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 毫秒时间戳 → '09-14 15:30' */
export function timeText(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 毫秒时间戳 → '15:30' */
export function clockText(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 名额紧张程度，用来决定进度条颜色和提示。
 * 返回 'none' | 'low' | 'ok'
 */
export function quotaLevel(item) {
  if (!item || !item.totalQuota) return 'ok';
  if (item.remainingQuota <= 0) return 'none';
  return item.remainingQuota / item.totalQuota <= 0.3 ? 'low' : 'ok';
}

/** 剩余名额的展示文案 */
export function quotaText(item) {
  if (!item) return '';
  if (item.remainingQuota <= 0) return '已约满';
  return `还剩 ${item.remainingQuota} / ${item.totalQuota}`;
}

/** 进度条宽度百分比，供 style 用 */
export function quotaPercent(item) {
  if (!item || !item.totalQuota) return 0;
  return Math.max(0, Math.min(100, Math.round((item.remainingQuota / item.totalQuota) * 100)));
}

/** 取货人展示：'王雨桐（尾号 3456）' —— 志愿者靠这个核对身份 */
export function pickerLabel(user) {
  if (!user) return '—';
  const sid = String(user.sid || '');
  return sid ? `${user.name}（尾号 ${sid.slice(-4)}）` : user.name;
}
