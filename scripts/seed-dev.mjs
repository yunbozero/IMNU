/**
 * 本地联调用的演示数据。
 *
 *   npm run seed
 *
 * 为什么需要它：管理端界面还没做，而新建的本地库是空的 ——
 * 没有活动、摊位和物品，小程序的首页/列表/详情/预定全都只能看到空状态，
 * 联调就等于没测。
 *
 * 只在本地跑：和 DEV_FAKE_LOGIN 同样的两道锁，命中就拒绝启动。
 * 逻辑抽成导出的函数，是为了能在测试里直接验（沙箱里起不了子进程，
 * 没法靠 `node scripts/seed-dev.mjs` 来测）。
 */
import { openMigrated, DEV_DB_PATH } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';

/**
 * 拦截「这是线上」的两种情况。
 * 抛错而不是 process.exit，方便测试直接断言。
 */
export function assertLocalOnly(env = {}, dbPath = '') {
  if (env.NODE_ENV === 'production') {
    throw new Error('拒绝运行：NODE_ENV=production。演示数据只能在本地库上造。');
  }
  if (String(dbPath).includes('/srv/bazaar')) {
    throw new Error(`拒绝运行：目标库是线上路径 ${dbPath}。演示数据只能在本地库上造。`);
  }
}

/** 演示数据的样子。emoji 和 tint 要和 app.wxss 里定义的色底类对得上。 */
export const DEMO = {
  event: { name: '演示义卖（本地）', status: 'on_sale' },
  stalls: [
    { name: '一号摊位 · 手作烘焙', loc: '图书馆前广场东侧' },
    { name: '二号摊位 · 闲置好物', loc: '图书馆前广场西侧' },
  ],
  items: [
    { stall: 0, name: '手作黄油曲奇', description: '独立包装，一盒六块', emoji: '🍪', tint: 't-yellow', totalQuota: 12 },
    { stall: 0, name: '多肉小盆栽', description: '随机品种，带小陶盆', emoji: '🪴', tint: 't-green', totalQuota: 8 },
    { stall: 0, name: '手写书签', description: '手写小楷，可自选句子', emoji: '🔖', tint: 't-pink', totalQuota: 20 },
    { stall: 1, name: '旧教材《高等数学》', description: '上册，有笔记，介意勿拍', emoji: '📚', tint: 't-blue', totalQuota: 5 },
    { stall: 1, name: '帆布环保袋', description: '印校园猫原创图案', emoji: '👜', tint: 't-orange', totalQuota: 10 },
    // 名额故意留少，用来验证「快约满 / 已约满」这两种界面状态
    { stall: 1, name: '毛线玩偶（限量）', description: '手工钩织，仅三只', emoji: '🧸', tint: 't-purple', totalQuota: 3 },
  ],
  /**
   * 两个演示身份。假登录下 code 直接映射成 openid，
   * 所以用 dev-volunteer 登录就是这个人 —— 用来测志愿者核销台。
   */
  users: [
    { code: 'dev-volunteer', sid: null, name: '演示志愿者', role: 'volunteer' },
  ],
};

/**
 * 往库里塞一份演示数据。
 * 已经有一个在售活动就跳过 —— 重复跑不该造出一堆重复物品，
 * 也不该出现两个同时在售的活动（getActiveEvent 只认一个）。
 */
export function seedDemoData(repo, demo = DEMO) {
  const active = repo.getActiveEvent();
  if (active) {
    return { skipped: true, eventId: active.id, activeName: active.name };
  }

  const event = repo.createEvent(demo.event);
  const stalls = demo.stalls.map((s) => repo.createStall({ eventId: event.id, ...s }));

  const items = demo.items.map((it) => repo.createItem({
    eventId: event.id,
    stallId: stalls[it.stall].id,
    name: it.name,
    description: it.description,
    emoji: it.emoji,
    tint: it.tint,
    totalQuota: it.totalQuota,
  }));

  const users = demo.users.map((u) => repo.createUser({
    openid: `openid:${u.code}`, sid: u.sid, name: u.name, role: u.role,
  }).user);

  return { skipped: false, eventId: event.id, stalls: stalls.length, items: items.length, users: users.length };
}

function main() {
  const dbPath = process.env.DB_PATH || DEV_DB_PATH;

  try {
    assertLocalOnly(process.env, dbPath);
  } catch (e) {
    console.error(`[x] ${e.message}`);
    process.exit(1);
  }

  const db = openMigrated(dbPath);
  const repo = createSqliteRepository(db);

  try {
    const r = seedDemoData(repo);

    console.log(`数据库：${dbPath}`);
    if (r.skipped) {
      console.log(`已有一个在售活动「${r.activeName}」，跳过造数据（不会重复造）。`);
    } else {
      console.log(`✅ 已造好演示数据：${r.items} 个物品 / ${r.stalls} 个摊位 / ${r.users} 个演示身份`);
    }

    console.log('\n接下来：');
    console.log('  1. 起后端：       DEV_FAKE_LOGIN=1 npm start');
    console.log('     （Windows PowerShell：$env:DEV_FAKE_LOGIN=\'1\'; npm start）');
    console.log('  2. 开发者工具里进小程序 → 填个昵称完成登记');
    console.log('  3. 想当管理员（管理端 + 核销台都能进）：');
    console.log('       npm run set-owner -- --list     # 找到自己那行的 openid');
    console.log('       npm run set-owner <你的openid>');
    console.log('');
    console.log('  注：演示志愿者在开发者工具里用不上 —— 工具里没法指定登录 code');
    console.log('      （wx.login 给的是随机串），它只在自动化测试里有意义。');
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
