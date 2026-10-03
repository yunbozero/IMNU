/**
 * 活动时间的解析与显示。
 *
 * 抽成独立模块，是因为**脚本和接口必须用同一套解析** ——
 * `scripts/init-event.mjs` 从配置文件读时间，`POST /api/admin/event`
 * 从请求体读时间，两边一旦不一致，同一句「2026-04-18 09:00」会存成两个不同的时刻。
 *
 * ★ 一定要带上 +08:00，不能直接 `new Date('2026-04-18 09:00')`：
 *   后者按**运行环境本地时区**解释这个字符串，而云服务器默认是 UTC。
 *   在 UTC 机器上把「09:00」解析成 09:00Z，学生手机上（+08:00）看到的就是 17:00 ——
 *   首页那行「9:00–17:00」会整整差 8 小时，而且本地怎么测都是对的。
 *   活动时间永远是北京时间，所以写死 +08:00。
 *
 * ★ 前端不要自己算时间戳：小程序那边用 `<picker mode="date">` +
 *   `<picker mode="time">` 拿到「2026-04-18」和「09:00」两段字符串，拼起来发过来即可。
 *   手机上 `new Date(...)` 按手机时区解释，看着对，但库存在服务器上就未必 ——
 *   把解析放在唯一一处，比两边各算一遍安全。
 */

/** 北京时间相对 UTC 的偏移（分钟） */
const CN_OFFSET_MIN = 8 * 60;

/**
 * `"2026-04-18 09:00"` → 毫秒时间戳（按北京时间解释）。
 * 空值返回 null（这两个字段可以为空）。格式不对抛错，报错里带字段名。
 */
export function parseEventTime(v, field) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') {
    throw new Error(`${field} 要写成 "2026-04-18 09:00" 这样的字符串`);
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(v.trim());
  if (!m) throw new Error(`${field} 格式不对，应当形如 "2026-04-18 09:00"`);

  const [, y, mo, d, h, mi] = m;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:00+08:00`);
  if (!Number.isFinite(ms)) throw new Error(`${field}「${v}」不是一个真实的日期`);

  // ★ 光靠 Date.parse 拦不住「2 月 30 日」：V8 对 ISO 字符串里的越界日期是
  //   **往后滚动**而不是报错，'2026-02-30T09:00:00+08:00' 会静悄悄变成 3 月 2 日。
  //   所以按北京时间把结果渲染回去，和原文核对一遍。
  const back = new Date(ms + CN_OFFSET_MIN * 60 * 1000).toISOString().slice(0, 16);
  if (back !== `${y}-${mo}-${d}T${h}:${mi}`) {
    throw new Error(`${field}「${v}」不是一个真实的日期`);
  }

  return ms;
}

/** 校验一个时间区间：结束不能早于开始。两者都可为空。 */
export function checkRange(startsAt, endsAt, labels = {}) {
  const s = labels.start || '开始时间';
  const e = labels.end || '结束时间';
  if (startsAt !== null && endsAt !== null && endsAt < startsAt) {
    // 字段名是拉丁文、连接词是中文，加空格才读得顺
    throw new Error(`${e} 比 ${s} 还早`);
  }
}

/** 毫秒时间戳 → `"2026-04-18 09:00"`（北京时间）。给界面回显用。 */
export function formatEventTime(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms) + CN_OFFSET_MIN * 60 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
