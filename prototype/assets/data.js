/* ============================================================
   IMNU 校园义卖 · 原型假数据
   注意：本文件刻意不含任何交易或费用字段，这是硬性设计约束
   ============================================================ */

const EVENT = {
  name: 'IMNU 校园义卖',
  date: '9月20日 10:00 – 16:00',
  place: '图书馆前广场',
  host: '校学生社团联合会',
};

const STALLS = [
  { id: 'st1', name: '一号摊位', loc: '图书馆前广场东侧' },
  { id: 'st2', name: '二号摊位', loc: '学生活动中心门口' },
  { id: 'st3', name: '三号摊位', loc: '教学楼A座连廊' },
];

const ITEMS = [
  { id: 'i1', name: '手作黄油曲奇（6枚装）', stall: 'st2', emoji: '🍪', tint: 't-yellow',
    total: 40, remaining: 12, tags: ['手作', '限量'],
    desc: '烘焙社同学提前一天手作，独立包装。含黄油与坚果，过敏请留意。' },

  { id: 'i2', name: '考研数学全套教材', stall: 'st1', emoji: '📚', tint: 't-blue',
    total: 1, remaining: 0, tags: ['二手', '9成新'],
    desc: '含详细笔记与错题标注，整套转让，不接受拆分。' },

  { id: 'i3', name: '多肉小盆栽', stall: 'st3', emoji: '🪴', tint: 't-green',
    total: 30, remaining: 23, tags: ['随机品种'],
    desc: '随机品种，带简易花盆与养护说明卡，先到先选。' },

  { id: 'i4', name: '校园文创帆布包', stall: 'st1', emoji: '👜', tint: 't-pink',
    total: 25, remaining: 6, tags: ['文创'],
    desc: '原创设计，加厚帆布，可放 14 寸笔记本。' },

  { id: 'i5', name: '手工编织钥匙扣', stall: 'st3', emoji: '🧶', tint: 't-purple',
    total: 50, remaining: 41, tags: ['手作'],
    desc: '手工编织，配色随机发放。' },

  { id: 'i6', name: '二手尤克里里', stall: 'st1', emoji: '🎸', tint: 't-orange',
    total: 1, remaining: 1, tags: ['二手', '仅1件'],
    desc: '23 寸，音准良好，附琴包与备用琴弦。' },

  { id: 'i7', name: '手写书签（现场题字）', stall: 'st2', emoji: '🖌️', tint: 't-blue',
    total: 60, remaining: 58, tags: ['现场制作'],
    desc: '现场题字，可指定内容，约需等待 5 分钟。' },

  { id: 'i8', name: '自制柠檬茶', stall: 'st2', emoji: '🥤', tint: 't-green',
    total: 30, remaining: 0, tags: ['限量'],
    desc: '当日现做，冰镇供应。' },

  { id: 'i9', name: '毛绒玩偶（二手）', stall: 'st1', emoji: '🧸', tint: 't-pink',
    total: 15, remaining: 9, tags: ['二手'],
    desc: '已清洗消毒，成色良好，随机款式。' },

  { id: 'i10', name: '手绘明信片套装', stall: 'st3', emoji: '💌', tint: 't-yellow',
    total: 40, remaining: 33, tags: ['手绘', '3张/套'],
    desc: '手绘校园风景，一套 3 张，可按套领取。' },
];

/* 预置的他人预定记录，用于演示志愿者核销端 */
const SEED_RESERVATIONS = [
  { id: 'r-seed-1', itemId: 'i1', qty: 1, code: '482913',
    userName: '王雨桐', userSid: '2021****37', status: 'reserved' },

  { id: 'r-seed-2', itemId: 'i4', qty: 1, code: '731206',
    userName: '李承泽', userSid: '2022****14', status: 'reserved' },

  { id: 'r-seed-3', itemId: 'i5', qty: 2, code: '295671',
    userName: '赵语彤', userSid: '2020****08', status: 'redeemed',
    operator: '志愿者 陈亦航' },
];
