/**
 * 图鉴表单的**纯逻辑**：可选状态/性别/配色、字数上限、校验、组装请求体。
 *
 * 抽成不依赖 wx 的纯模块，是为了能在 tests 里直接 import 来验 ——
 * 页面文件（Page({...})）在 Node 里根本加载不了。
 *
 * ★ 下面这些上限和枚举是**服务端 server/api.mjs 的副本**（小程序不能 import 服务端代码）。
 *   tests/miniprogram.test.mjs 会拿服务端那份逐个比对，改了不同步就会红。
 *   界面这边放得比服务端宽的话，用户会一路填到点提交才被拒 ——
 *   报错出现在最后一步，还说不清是哪一项超了。
 */
import { TINTS, EMOJI_MAX } from './item-form.js';

export const NAME_MAX = 12;
export const LOC_MAX = 30;
export const PERSONALITY_MAX = 60;
export const NOTE_MAX = 60;

/** 和服务端 CAT_STATUSES 一一对应。key 存在数据库里，label 只给界面看。 */
export const STATUSES = [
  { key: 'onCampus', label: '在校' },
  { key: 'missing', label: '失踪' },
  { key: 'passed', label: '离世' },
];

/** 和服务端 CAT_GENDERS 一一对应。做成选项而不是自由输入，数据才不会五花八门。 */
export const GENDERS = ['公', '母', '未知'];

/** 猫的图标建议。手机上翻 emoji 键盘很麻烦，给几个能直接点的。 */
export const EMOJI_SUGGESTIONS = ['🐱', '🐈', '🐈‍⬛', '🐾', '😺', '😻', '😿', '🙀'];

/** 底色和物品共用同一套（app.wxss 里的 .t-*），所以直接复用那份列表 */
export { TINTS, EMOJI_MAX };

/** 状态在选择器里显示成什么样 */
export function statusLabel(key) {
  const s = STATUSES.find((x) => x.key === key);
  return s ? s.label : '';
}

/** 选择器下标 → 状态 key */
export function statusAt(index) {
  const s = STATUSES[Number(index)];
  return s ? s.key : STATUSES[0].key;
}

/** 状态 key → 选择器下标 */
export function statusIndex(key) {
  const i = STATUSES.findIndex((x) => x.key === key);
  return i < 0 ? 0 : i;
}

/** 性别选择器下标 */
export function genderIndex(gender) {
  const i = GENDERS.indexOf(gender);
  return i < 0 ? GENDERS.length - 1 : i;   // 认不出来就当「未知」
}

/**
 * 校验表单并组装请求体。
 *
 * 新建和编辑**共用这一份**：编辑时表单里就是这只猫的全部当前值，
 * 整体提交比「算哪些字段变了」简单得多，也不会出现「改了没保存上」那种
 * 只在某个字段上发生的怪 bug。服务端那边仍然是「传什么改什么」。
 *
 * 返回 { ok: true, body } 或 { ok: false, error }（error 是能直接弹给人看的中文）。
 */
export function buildCatBody(form = {}) {
  const name = String(form.name || '').trim();
  if (!name) return { ok: false, error: '请给它起个名字' };
  if ([...name].length > NAME_MAX) return { ok: false, error: `名字最多 ${NAME_MAX} 个字` };

  const brief = (value, max, label) => {
    const s = String(value || '').trim();
    if ([...s].length > max) return { error: `${label}最多 ${max} 个字` };
    return { value: s };
  };

  const location = brief(form.location, LOC_MAX, '出没地点');
  if (location.error) return { ok: false, error: location.error };

  const personality = brief(form.personality, PERSONALITY_MAX, '性格');
  if (personality.error) return { ok: false, error: personality.error };

  const note = brief(form.note, NOTE_MAX, '备注');
  if (note.error) return { ok: false, error: note.error };

  const emoji = String(form.emoji || '').trim();
  // 按码点数：'🐱'.length 是 2，用 length 的话一个 emoji 就顶满了
  if ([...emoji].length > EMOJI_MAX) return { ok: false, error: `图标最多 ${EMOJI_MAX} 个字` };

  // 配色认不出来就回落到第一个，而不是把非法值发给服务端 —— 那只会白挨一次 400
  const tint = TINTS.some((t) => t.key === form.tint) ? form.tint : TINTS[0].key;

  // 照片**只透传文件名**，不做本地校验：文件是选图时就已经传上去的，
  // 而「这个文件到底在不在」只有服务端说了算（它会查磁盘）。
  const image = form.image ? String(form.image) : null;

  const gender = GENDERS.includes(form.gender) ? form.gender : '未知';

  return {
    ok: true,
    body: {
      name,
      emoji,
      tint,
      image,
      status: statusAt(form.statusIndex),
      gender,
      location: location.value,
      personality: personality.value,
      note: note.value,
    },
  };
}
