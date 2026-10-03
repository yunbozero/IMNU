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
 * ------------------------------------------------------------------
 * 照片怎么放
 * ------------------------------------------------------------------
 * 照片**不放包里**，放仓库的 `assets/cats/`，发布时 `deploy.sh` 同步到服务器的
 * 图片目录，nginx 直接发。为什么：
 *   · 主包有 2MB 硬上限，十几张照片就顶满了，而主包每次冷启动都要下载一遍
 *     （仓库自己的原则就是「主包要尽量小」，照片搬进来等于自打嘴巴）；
 *   · 放服务器上改一张图不用重新发版。
 * 这里只写**文件名**（如 `cats/daju.jpg`），完整地址由 `utils/format.js`
 * 的 `imageUrl()` 拼 —— 和物品照片同一个套路。
 *
 * ★ 文件名必须是**纯 ASCII**（小写字母/数字/下划线，见 `assets/cats/README.md`）。
 *   小程序的 `<image>` 会把中文名做百分号编码，而服务端的静态服务**故意不做
 *   URL 解码**（那是为了防路径穿越），于是 `cats/大橘.jpg` 会直接 404。
 *   有测试守着这一点。
 *
 * 没有照片、或者照片加载失败时，界面回落到 `emoji` + `tint` 那个色块 ——
 * 所以断网也能看图鉴。
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
    // ★ 有照片就写文件名（相对图片目录）：'cats/daju.jpg'。
    //   文件名必须全小写 ASCII；没有照片就 null（界面回落 emoji + 底色）。
    image: null,
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
    image: null,
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
    image: null,
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
    image: null,
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
    image: null,
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
