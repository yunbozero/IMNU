/**
 * 纯展示用的格式化函数。都是纯函数，方便单测。
 */

/** '482913' → '482 913'，方便学生口报给志愿者 */
export function groupCode(code) {
  const s = String(code || '');
  return s.length === 6 ? `${s.slice(0, 3)} ${s.slice(3)}` : s;
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
