/**
 * 猫猫图鉴的静态数据。
 *
 * 刻意做成静态的：图鉴不常更新，没必要为它养一个后端。
 * 代价是改一次要发版（1–2 天审核），对图鉴这种低频内容可以接受。
 *
 * ⚠️ 这个文件必须放主包：**主包不能 require 分包的文件**，
 *    而图鉴列表页是 tabBar 页面、必须在主包。
 *    分包里的页面反过来可以 require 这里的（分包 → 主包是允许的）。
 *
 * 图片说明：小程序 <image> 组件的 src **不受服务器域名白名单限制**，
 * 所以照片可以放对象存储 + CDN，不需要备案域名。
 * 这里先用色块 + emoji 占位，等有真实照片再换。
 */

export const CAT_STATUS = {
  onCampus: '在校',
  missing: '失踪',
  passed: '离世',
};

export const CATS = [
  {
    id: 'c1',
    name: '大橘',
    emoji: '🐱',
    tint: 't-orange',
    status: 'onCampus',
    gender: '公',
    location: '图书馆前广场一带',
    personality: '亲人，会主动蹭腿，看到拿吃的会一路跟着走。',
    note: '已绝育。不要喂人类的零食和高盐食物。',
  },
  {
    id: 'c2',
    name: '奶牛',
    emoji: '🐈‍⬛',
    tint: 't-blue',
    status: 'onCampus',
    gender: '母',
    location: '学生活动中心门口',
    personality: '警惕性高，不让人靠近，但每天固定时间会来吃饭。',
    note: '已绝育。请勿追赶。',
  },
  {
    id: 'c3',
    name: '三花',
    emoji: '🐈',
    tint: 't-pink',
    status: 'onCampus',
    gender: '母',
    location: '三号教学楼连廊',
    personality: '安静，喜欢趴在窗台上晒太阳。',
    note: '胆小，看它的时候请放轻脚步。',
  },
  {
    id: 'c4',
    name: '小黑',
    emoji: '🐈‍⬛',
    tint: 't-purple',
    status: 'missing',
    gender: '公',
    location: '最后目击：体育馆西侧',
    personality: '怕人，但认得喂它的同学。',
    note: '2026 年 6 月后没有再出现。有线索请联系我们。',
  },
  {
    id: 'c5',
    name: '小橘白',
    emoji: '🐱',
    tint: 't-yellow',
    status: 'onCampus',
    gender: '公',
    location: '一号食堂后门',
    personality: '活泼，爱玩逗猫棒。',
    note: '2026 年春季新来的小猫。',
  },
];

export const CAT_LIST_GROUPS = [
  { key: 'onCampus', label: '在校' },
  { key: 'missing', label: '失踪' },
  { key: 'passed', label: '离世' },
];

export const findCat = (id) => CATS.find((c) => c.id === id) || null;
export const catsByStatus = (status) => CATS.filter((c) => c.status === status);

/** 喂养提示。和前端原型里的一致。 */
export const FEEDING_TIPS = [
  { label: '不要', text: '随意给流浪猫喂人类零食和高盐食物。', tone: 'warn' },
  { label: '禁忌', text: '巧克力、葡萄、洋葱、木糖醇等食物。', tone: 'warn' },
  { label: '避免', text: '火腿肠、牛奶、重油重辣和刺激性食物。', tone: 'warn' },
  { label: '推荐', text: '清水、猫粮、猫条和白水煮鸡胸肉。', tone: 'ok' },
];
