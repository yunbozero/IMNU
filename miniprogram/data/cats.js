/**
 * 猫猫图鉴的**界面文案和分组规则**。
 *
 * ★ 猫的**资料本身已经不在这里了** —— 它搬到了数据库（服务端的 cats 表），
 *   由 `services/cats.js` 拉。这样加一只猫、改一张照片都不用发版，
 *   而发一次版要等 1–2 天审核。
 *
 *   这里留下的是**只有界面才关心的东西**：
 *     · CAT_STATUS  状态键 → 中文文案
 *     · CAT_LIST_GROUPS  列表页顶部的分组
 *     · FEEDING_TIPS  喂养提示（一段固定的说明文字，不是数据）
 *   服务端存的是 `onCampus`/`missing`/`passed` 这些**键**，不存中文 ——
 *   文案改了不用动数据库。CAT_STATUS 的键必须和服务端的 CAT_STATUSES
 *   一一对应，有测试比对两边（缺了会显示成空白标签）。
 *
 * ⚠️ 这个文件必须放主包：**主包不能 require 分包的文件**，
 *    而图鉴列表页是 tabBar 页面、必须在主包。
 *    分包里的页面反过来可以 require 这里的（分包 → 主包是允许的）。
 *
 * 没有照片、或者照片加载失败时，界面回落到 `emoji` + `tint` 那个色块 ——
 * 所以图鉴仍然能看，不会出现空白。
 */

export const CAT_STATUS = {
  onCampus: '在校',
  missing: '失踪',
  passed: '离世',
};

export const CAT_LIST_GROUPS = [
  { key: 'onCampus', label: '在校' },
  { key: 'missing', label: '失踪' },
  { key: 'passed', label: '离世' },
];

/** 喂养提示。和前端原型里的一致。 */
export const FEEDING_TIPS = [
  { label: '不要', text: '随意给流浪猫喂人类零食和高盐食物。', tone: 'warn' },
  { label: '禁忌', text: '巧克力、葡萄、洋葱、木糖醇等食物。', tone: 'warn' },
  { label: '避免', text: '火腿肠、牛奶、重油重辣和刺激性食物。', tone: 'warn' },
  { label: '推荐', text: '清水、猫粮、猫条和白水煮鸡胸肉。', tone: 'ok' },
];
