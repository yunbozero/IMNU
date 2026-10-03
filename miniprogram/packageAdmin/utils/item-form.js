/**
 * 新建物品表单的**纯逻辑**：可选配色、字数上限、校验、组装请求体。
 *
 * 抽成不依赖 wx 的纯模块，是为了能在 tests 里直接 import 来验 ——
 * 页面文件（Page({...})）在 Node 里根本加载不了。
 *
 * ★ 下面这几个上限是**服务端 server/api.mjs 的副本**（小程序不能 import 服务端代码）。
 *   tests/miniprogram.test.mjs 会拿服务端那份逐个比对，改了不同步就会红。
 *   界面这边放得比服务端宽的话，用户会一路填到点提交才被拒 ——
 *   报错出现在最后一步，还说不清是哪一项超了。
 */

export const NAME_MAX = 20;
export const DESC_MAX = 40;
export const QUOTA_MAX = 9999;
export const EMOJI_MAX = 2;

/**
 * 可选的图标底色。key 就是 app.wxss 里的 .t-* 类名。
 * 必须和服务端的 ITEM_TINTS 完全一致 —— 对不上的类名不会报错，
 * 只会渲染成一个没有底色的白块。
 */
export const TINTS = [
  { key: 't-pink', label: '粉' },
  { key: 't-green', label: '绿' },
  { key: 't-blue', label: '蓝' },
  { key: 't-yellow', label: '黄' },
  { key: 't-purple', label: '紫' },
  { key: 't-orange', label: '橙' },
];

/** 常用图标。手机上翻 emoji 键盘很麻烦，给几个能直接点的。 */
export const EMOJI_SUGGESTIONS = ['🍪', '🧁', '🪴', '🔖', '📚', '👜', '🧸', '🎁', '🌸', '☕'];

/** 摊位选择器里的第一项：不指定摊位 */
export const NO_STALL_TEXT = '不指定摊位';

/** 摊位在选择器里显示成什么样 */
export function stallOptionText(stall) {
  if (!stall) return NO_STALL_TEXT;
  return stall.loc ? `${stall.name}（${stall.loc}）` : stall.name;
}

/** 选择器的选项文案。下标 0 固定是「不指定摊位」，所以选中项要减 1 才是 stalls 的下标。 */
export function stallOptions(stalls) {
  return [NO_STALL_TEXT, ...(stalls || []).map(stallOptionText)];
}

/** 选择器下标 → 摊位 id。0 表示不指定。 */
export function stallIdAt(stalls, index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i <= 0) return null;
  const s = (stalls || [])[i - 1];
  return s ? s.id : null;
}

/**
 * 校验表单并组装请求体。
 * 返回 { ok: true, body } 或 { ok: false, error }（error 是能直接弹给人看的中文）。
 */
export function buildCreateBody(form = {}, stalls = []) {
  const name = String(form.name || '').trim();
  if (!name) return { ok: false, error: '请填写物品名称' };
  if (name.length > NAME_MAX) return { ok: false, error: `名称最多 ${NAME_MAX} 个字` };

  // 名额是输入框里的字符串，可能带空格，也可能是空的或「五」
  const raw = String(form.totalQuota === undefined || form.totalQuota === null ? '' : form.totalQuota).trim();
  const totalQuota = raw === '' ? NaN : Number(raw);
  if (!Number.isInteger(totalQuota) || totalQuota < 1) {
    return { ok: false, error: '名额要填一个正整数' };
  }
  if (totalQuota > QUOTA_MAX) return { ok: false, error: `名额最多 ${QUOTA_MAX}` };

  const description = String(form.description || '').trim();
  if (description.length > DESC_MAX) return { ok: false, error: `简介最多 ${DESC_MAX} 个字` };

  const emoji = String(form.emoji || '').trim();
  // 按码点数：'🍪'.length 是 2，用 length 的话一个 emoji 就顶满了
  if ([...emoji].length > EMOJI_MAX) return { ok: false, error: `图标最多 ${EMOJI_MAX} 个字` };

  // 配色认不出来就回落到第一个，而不是把非法值发给服务端 —— 那只会白挨一次 400
  const tint = TINTS.some((t) => t.key === form.tint) ? form.tint : TINTS[0].key;

  // 照片**只透传文件名**，不做本地校验：文件是选图时就已经传上去的，
  // 而「这个文件到底在不在」只有服务端说了算（它会查磁盘）。这里拦一道
  // 反而会拦不住真正的问题，白让用户多挨一次错。
  const image = form.image ? String(form.image) : null;

  return {
    ok: true,
    body: {
      name,
      description,
      emoji,
      tint,
      image,
      totalQuota,
      stallId: stallIdAt(stalls, form.stallIndex),
    },
  };
}
