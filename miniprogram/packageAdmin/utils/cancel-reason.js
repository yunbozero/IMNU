/**
 * 管理端取消预定的原因。
 *
 * 抽成独立模块（而不是写在页面里）有两个原因：
 *   1. 页面在 Node 里 import 不了（`Page()` 不存在），放这里的逻辑才能被测试；
 *   2. 原因列表是产品决策，集中一处好改也好 review。
 *
 * 后端收的就是一个 2–60 字字符串，所以**加/改一个原因只改这里，不用动服务**。
 */

/** 预设原因。「其他」必须放最后，并且 key 是 OTHER_KEY。 */
export const REASONS = [
  { key: 'self', label: '本人要求取消' },
  { key: 'unreachable', label: '联系不上本人' },
  { key: 'duplicate', label: '重复占用（多号）' },
  { key: 'fake', label: '信息不实或冒名' },
  { key: 'unavailable', label: '物品已无法提供' },
];

export const OTHER_KEY = 'other';
export const OTHER_LABEL = '其他（手填）';

/** 后端对 reason 的限制：2–60 字。这里跟着改的话要同步 server/api.mjs 的 asReason。 */
export const REASON_MIN = 2;
export const REASON_MAX = 60;

/** 「其他：」这三个字符（含全角冒号） */
const PREFIX = '其他：';

/**
 * 把「选中的原因 + 手填文字」拼成最终发给后端的字符串。
 *
 * @returns {{ok: true, reason: string} | {ok: false, message: string}}
 */
export function composeReason(key, otherText = '') {
  if (key === OTHER_KEY) {
    const text = String(otherText || '').trim();
    // 拼上「其他：」之后总长不能超上限，所以要先把前缀算进去
    if (text.length < 1 || PREFIX.length + text.length > REASON_MAX) {
      return { ok: false, message: `请填写 1–${REASON_MAX - PREFIX.length} 个字的具体原因` };
    }
    return { ok: true, reason: PREFIX + text };
  }

  const hit = REASONS.find((r) => r.key === key);
  if (!hit) return { ok: false, message: '请选择取消原因' };

  // 预设标签本身也要落在后端允许的长度里，否则会被打回
  if (hit.label.length < REASON_MIN || hit.label.length > REASON_MAX) {
    return { ok: false, message: `原因文案不合法（应 ${REASON_MIN}–${REASON_MAX} 字）` };
  }
  return { ok: true, reason: hit.label };
}
