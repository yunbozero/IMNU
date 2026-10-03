/**
 * 生产数据初始化脚本（scripts/init-event.mjs）。
 *
 * 这个脚本能往**线上库**写活动 —— 是仓库里权限最大的一个东西，
 * 所以这里测的重点不是「正常路径能跑通」，而是：
 *   · 不加 --yes 时一个字节都不写（最重要的那条）
 *   · 重复运行不产生重复数据（否则补一次物品就多一批）
 *   · 活动时间按北京时间解析（服务器是 UTC 的话，差 8 小时且本地测不出来）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import { startServer } from '../server/http.mjs';
import { createFakeSessionProvider } from '../server/auth.mjs';
import { ITEM_TINTS } from '../server/api.mjs';
import {
  parseEventTime, parseConfig, planInit, formatPlan, applyInit, parseArgs, run,
} from '../scripts/init-event.mjs';

/** 一份合法配置。每个用例在它上面只改一处。 */
function sampleConfig(over = {}) {
  return {
    event: { name: '檐下猫小记 · 闲置物品登记', startsAt: '2026-04-18 09:00', endsAt: '2026-04-18 17:00' },
    stalls: [
      { name: '一号摊位 · 手作烘焙', loc: '图书馆前广场东侧' },
      { name: '二号摊位 · 闲置好物' },
    ],
    items: [
      { stall: '一号摊位 · 手作烘焙', name: '手作黄油曲奇', emoji: '🍪', tint: 't-yellow', totalQuota: 12 },
      { stall: '二号摊位 · 闲置好物', name: '帆布环保袋', emoji: '👜', tint: 't-orange', totalQuota: 10 },
    ],
    ...over,
  };
}

function withRepo(fn) {
  const db = openMigrated(':memory:');
  try {
    return fn(createSqliteRepository(db), db);
  } finally {
    db.close();
  }
}

/** 临时目录 + 里面的一个配置文件 */
function tempConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-init-'));
  const file = path.join(dir, 'event.json');
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config), 'utf8');
  return { dir, file, dbPath: path.join(dir, 'bazaar.db') };
}

/* ============================================================
   活动时间：必须是北京时间
   ============================================================ */

test('init-event：活动时间按北京时间解析，不受服务器时区影响', () => {
  const ms = parseEventTime('2026-04-18 09:00', 'event.startsAt');

  // toISOString 永远是 UTC，所以这条断言在任何时区的机器上都成立。
  // ★ 反过来说：如果实现改成 new Date('2026-04-18 09:00')（按本机时区解释），
  //   在 UTC 的云服务器上这里会得到 09:00Z，学生手机（+08:00）看到的是 17:00。
  assert.equal(new Date(ms).toISOString(), '2026-04-18T01:00:00.000Z',
    '09:00 北京时间 = 01:00 UTC，差 8 小时就是时区没处理对');

  // 带 T 的写法也认
  assert.equal(parseEventTime('2026-04-18T09:00', 'x'), ms);

  // 不填就是 null（这两个字段可以为空）
  for (const empty of [undefined, null, '']) {
    assert.equal(parseEventTime(empty, 'x'), null);
  }
});

test('init-event：时间格式不对要说清楚是哪个字段', () => {
  const bad = [
    ['2026/04/18 09:00', /startsAt/],
    ['2026-04-18', /startsAt/],
    ['09:00', /startsAt/],
    ['2026-04-18 09:00:00', /startsAt/],
    [20260418090000, /字符串/],
  ];
  for (const [v, re] of bad) {
    assert.throws(() => parseEventTime(v, 'startsAt'), re,
      `「${v}」应当被拒，且报错要指明是 event.startsAt`);
  }

  // 2 月 30 日不存在。
  // ★ 注意 V8 对 ISO 字符串里的越界日期是**往后滚动**而不是报错，
  //   Date.parse('2026-02-30T09:00:00+08:00') 会静悄悄变成 3 月 2 日，
  //   所以光靠 Date.parse + isFinite 拦不住，必须回头核对。
  assert.throws(() => parseEventTime('2026-02-30 09:00', 'startsAt'), /真实的日期/);
  assert.throws(() => parseEventTime('2026-04-31 09:00', 'startsAt'), /真实的日期/);
  assert.throws(() => parseEventTime('2026-13-01 09:00', 'startsAt'), /真实的日期/);
  assert.throws(() => parseEventTime('2026-04-18 25:00', 'startsAt'), /真实的日期/);
});

/* ============================================================
   配置校验
   ============================================================ */

test('init-event：配置错误要逐条指出来', () => {
  const cases = [
    [null, /JSON 对象/],
    [{}, /缺少 event/],
    [{ event: {} }, /name 必填/],
    [{ event: { name: 'x'.repeat(41) } }, /最多 40/],
    [{ event: { name: 'a', status: '乱七八糟' } }, /status 只能是/],
    [{ event: { name: 'a', startsAt: '2026-04-18 17:00', endsAt: '2026-04-18 09:00' } }, /比 startsAt 还早/],
    [{ event: { name: 'a' }, stalls: '不是数组' }, /stalls 必须是数组/],
    [{ event: { name: 'a' }, stalls: [{}] }, /stalls\[0\]\.name 必填/],
    [{ event: { name: 'a' }, stalls: [{ name: '一号' }, { name: '一号' }] }, /出现了两次/],
    [{ event: { name: 'a' }, items: [{}] }, /items\[0\]\.name 必填/],
    [{ event: { name: 'a' }, items: [{ name: 'x' }] }, /totalQuota/],
    [{ event: { name: 'a' }, items: [{ name: 'x', totalQuota: 0 }] }, /totalQuota/],
    [{ event: { name: 'a' }, items: [{ name: 'x', totalQuota: 10000 }] }, /totalQuota/],
    [{ event: { name: 'a' }, items: [{ name: 'x', totalQuota: 1, tint: 't-乱写' }] }, /tint 只能是/],
    [{
      event: { name: 'a' },
      items: [{ name: 'x', totalQuota: 1, emoji: '三个字' }],
    }, /emoji 最多/],
    [{
      event: { name: 'a' },
      items: [{ name: 'x', totalQuota: 1, description: 'x'.repeat(41) }],
    }, /description 最多/],
    [{
      event: { name: 'a' },
      items: [{ name: 'x', totalQuota: 1, stall: '不存在的摊位' }],
    }, /不在 stalls 列表里/],
    [{
      event: { name: 'a' },
      items: [{ name: '同名', totalQuota: 1 }, { name: '同名', totalQuota: 1 }],
    }, /出现了两次/],
  ];

  for (const [raw, re] of cases) {
    assert.throws(() => parseConfig(raw), re, `应当拒绝：${JSON.stringify(raw)}`);
  }
});

test('init-event：不填的字段要有合理默认值', () => {
  const cfg = parseConfig({ event: { name: '义卖' }, items: [{ name: '东西', totalQuota: 3 }] });

  assert.equal(cfg.event.status, 'on_sale', '不写 status 就该直接上架 —— 建个草稿等于没建');
  assert.equal(cfg.event.startsAt, null);
  assert.equal(cfg.event.endsAt, null);
  assert.deepEqual(cfg.stalls, []);
  assert.equal(cfg.items[0].tint, ITEM_TINTS[0], '不写配色要给默认色，否则小程序渲染成白块');
  assert.equal(cfg.items[0].stall, null, '不写摊位就是未分配摊位');
  assert.equal(cfg.items[0].description, null);
  assert.equal(cfg.items[0].emoji, null);
});

test('init-event：和接口用同一套物品上限，不各写一份', () => {
  // 上限放宽了脚本却还按旧值拦，会出现「界面上建得出来、脚本说不行」
  assert.throws(() => parseConfig(sampleConfig({
    items: [{ name: 'x'.repeat(21), totalQuota: 1 }],
  })), /最多 20/);
  assert.doesNotThrow(() => parseConfig(sampleConfig({
    items: [{ name: 'x'.repeat(20), totalQuota: 9999 }],
  })));
});

/* ============================================================
   计划与执行
   ============================================================ */

test('init-event：空库上全部新建', () => {
  withRepo((repo) => {
    const cfg = parseConfig(sampleConfig());
    const plan = planInit(repo, cfg);

    assert.equal(plan.event.action, 'create');
    assert.equal(plan.eventId, null);
    assert.deepEqual(plan.stalls.map((s) => s.action), ['create', 'create']);
    assert.deepEqual(plan.items.map((i) => i.action), ['create', 'create']);
    assert.equal(plan.activeConflict, null);

    const text = formatPlan(plan, cfg);
    assert.match(text, /\[新建\] 状态 on_sale/);
    assert.match(text, /手作黄油曲奇 {2}12 份/);
    assert.match(text, /@ 一号摊位 · 手作烘焙/);
  });
});

test('init-event：写完之后学生那头的接口就能看到', () => {
  withRepo((repo) => {
    const cfg = parseConfig(sampleConfig());
    const r = applyInit(repo, cfg);

    assert.equal(r.eventAction, 'create');
    assert.equal(r.itemsCreated, 2);
    assert.equal(r.stallsCreated, 2);

    const active = repo.getActiveEvent();
    assert.equal(active.id, r.eventId, '活动要能在售 —— 否则小程序还是「活动还没开始」');

    const stalls = repo.listStalls(r.eventId);
    const items = repo.listItems(r.eventId, { onlyOnSale: true });
    assert.equal(items.length, 2);

    const cookie = items.find((i) => i.name === '手作黄油曲奇');
    assert.equal(cookie.totalQuota, 12);
    assert.equal(cookie.remainingQuota, 12, '名额要从满的开始');
    assert.equal(cookie.stallId, stalls.find((s) => s.name === '一号摊位 · 手作烘焙').id,
      '物品要挂在配置指定的那个摊位上');

    const bag = items.find((i) => i.name === '帆布环保袋');
    assert.equal(bag.stallId, stalls.find((s) => s.name === '二号摊位 · 闲置好物').id);
  });
});

test('init-event：★ 重复运行不会造出重复数据', () => {
  withRepo((repo) => {
    const cfg = parseConfig(sampleConfig());
    applyInit(repo, cfg);

    // 第二次跑：计划和执行都应当什么都不做
    const plan = planInit(repo, cfg);
    assert.equal(plan.event.action, 'reuse');
    assert.deepEqual(plan.stalls.map((s) => s.action), ['reuse', 'reuse']);
    assert.deepEqual(plan.items.map((i) => i.action), ['skip', 'skip']);

    const r2 = applyInit(repo, cfg);
    assert.equal(r2.itemsCreated, 0);
    assert.equal(r2.stallsCreated, 0);

    // 整个库里还是一个活动、两个摊位、两件物品
    assert.equal(repo.listEvents().length, 1);
    assert.equal(repo.listStalls(r2.eventId).length, 2);
    assert.equal(repo.listItems(r2.eventId).length, 2);
  });
});

test('init-event：补物品时只加新的，已有的原样不动', () => {
  withRepo((repo) => {
    const first = parseConfig(sampleConfig());
    const r1 = applyInit(repo, first);

    // 有人预定了曲奇，名额从 12 掉到 11
    const cookie = repo.listItems(r1.eventId).find((i) => i.name === '手作黄油曲奇');
    const u = repo.createUser({ openid: 'o1', name: '甲' }).user;
    repo.tryReserve({
      eventId: r1.eventId, itemId: cookie.id, userId: u.id,
      requestId: 'r1', code: '123456', maxPerUser: 0,
    });

    // 配置里追加一件，再跑一次
    const more = sampleConfig({
      items: [
        ...sampleConfig().items,
        { stall: '一号摊位 · 手作烘焙', name: '毛线玩偶', emoji: '🧸', tint: 't-purple', totalQuota: 3 },
      ],
    });
    const r2 = applyInit(repo, parseConfig(more));

    assert.equal(r2.itemsCreated, 1, '只该新建追加的那一件');
    assert.equal(r2.itemsSkipped, 2);
    assert.equal(repo.listEvents().length, 1, '不能因为补物品就再建一个活动');

    const after = repo.listItems(r1.eventId);
    assert.equal(after.length, 3);
    assert.equal(after.find((i) => i.name === '手作黄油曲奇').remainingQuota, 11,
      '已有的物品不能被重置名额 —— 那会让已经预定的人凭空多出一份');
  });
});

test('init-event：draft 状态的活动也不会被重复创建', () => {
  withRepo((repo) => {
    // getActiveEvent 看不见 draft。只靠它判断的话，第二次跑会再建一个同名活动。
    const cfg = parseConfig(sampleConfig({ event: { name: '草稿义卖', status: 'draft' } }));
    applyInit(repo, cfg);
    assert.equal(repo.getActiveEvent(), null, 'draft 不该出现在售');

    const plan = planInit(repo, cfg);
    assert.equal(plan.event.action, 'reuse', '必须靠 listEvents 找到草稿状态的那个');

    applyInit(repo, cfg);
    assert.equal(repo.listEvents().length, 1);
  });
});

test('init-event：库里另有在售活动时要提醒，但不拦', () => {
  withRepo((repo) => {
    repo.createEvent({ name: '上学期的义卖', status: 'on_sale' });

    const cfg = parseConfig(sampleConfig());
    const plan = planInit(repo, cfg);
    assert.deepEqual(plan.activeConflict, { id: plan.activeConflict.id, name: '上学期的义卖' });

    const text = formatPlan(plan, cfg);
    assert.match(text, /在售的活动是「上学期的义卖」/);
    assert.match(text, /首页只认最新建的那个/);

    // 提醒了也还是要能建 —— 拦下来只会让人以为脚本坏了
    assert.doesNotThrow(() => applyInit(repo, cfg));
  });
});

test('init-event：活动不是 on_sale 时，计划里要说明学生看不到', () => {
  withRepo((repo) => {
    const cfg = parseConfig(sampleConfig({ event: { name: '草稿义卖', status: 'draft' } }));
    const text = formatPlan(planInit(repo, cfg), cfg);
    assert.match(text, /小程序看不到它/);
  });
});

test('init-event：复用到一个已结束的活动上，也要提醒', () => {
  withRepo((repo) => {
    const cfg = parseConfig(sampleConfig({ event: { name: '去年的义卖', status: 'on_sale' } }));
    applyInit(repo, cfg);

    // 活动结束之后又拿同一份配置补物品 —— 最容易看漏的一种：
    // 脚本报告「新建了 N 件物品」，然后小程序里什么都没有
    repo._raw.prepare("UPDATE events SET status = 'ended'").run();

    const plan = planInit(repo, cfg);
    assert.equal(plan.event.action, 'reuse');
    assert.equal(plan.event.status, 'ended');

    const text = formatPlan(plan, cfg);
    assert.match(text, /当前状态 ended/);
    assert.match(text, /小程序看不到它/);
  });
});

test('init-event：写库会留下操作日志', () => {
  withRepo((repo, db) => {
    applyInit(repo, parseConfig(sampleConfig()));

    const row = db.prepare(
      "SELECT * FROM audit_logs WHERE action = 'event.init' ORDER BY id DESC LIMIT 1"
    ).get();
    assert.ok(row, '要留下 event.init 日志 —— 事后有人问「这活动谁建的」时查得到');
    assert.equal(row.actor_id, null, '脚本操作没有 actor，null 表示是服务端脚本做的');

    const detail = JSON.parse(row.detail);
    assert.equal(detail.via, 'scripts/init-event.mjs');
    assert.equal(detail.itemsCreated, 2);
  });
});

/* ============================================================
   命令行：默认不写库
   ============================================================ */

test('init-event：参数解析', () => {
  assert.deepEqual(parseArgs(['a.json']), { file: 'a.json', yes: false, help: false });
  assert.equal(parseArgs(['a.json', '--yes']).yes, true);
  assert.equal(parseArgs(['-y', 'a.json']).yes, true);
  assert.equal(parseArgs(['--help']).help, true);

  assert.throws(() => parseArgs(['a.json', 'b.json']), /多余的参数/);
  assert.throws(() => parseArgs(['--yes', '--乱写']), /不认识的参数/);
});

test('init-event：★ 不加 --yes 时一个字节都不写', () => {
  const t = tempConfig(sampleConfig());
  try {
    const lines = [];
    const code = run({ argv: [t.file], env: { DB_PATH: t.dbPath }, out: (s) => lines.push(s) });

    assert.equal(code, 0);
    const text = lines.join('\n');
    assert.match(text, /没有写库/, '要明确告诉用户什么都没写');
    assert.match(text, new RegExp(t.dbPath.replace(/[\\]/g, '\\\\')), '要把目标库打在屏幕最前面');
    assert.match(text, /--yes/, '要告诉他把 --yes 加上就能真写');

    // ★ 这才是这条测试真正要断言的东西
    assert.ok(!fs.existsSync(t.dbPath), '不带 --yes 时连数据库文件都不该被建出来');
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test('init-event：加上 --yes 才真的写，并且可重复跑', () => {
  const t = tempConfig(sampleConfig());
  try {
    const lines = [];
    const out = (s) => lines.push(s);

    assert.equal(run({ argv: [t.file, '--yes'], env: { DB_PATH: t.dbPath }, out }), 0);
    assert.match(lines.join('\n'), /已写入库/);

    // 直接开库看，不通过脚本的返回值得出结论
    const db = openMigrated(t.dbPath);
    try {
      const repo = createSqliteRepository(db);
      assert.equal(repo.getActiveEvent().name, '檐下猫小记 · 闲置物品登记');
      assert.equal(repo.listItems(repo.getActiveEvent().id).length, 2);
    } finally { db.close(); }

    // 库已经存在了，此时不带 --yes 的计划必须反映真实内容（复用而不是新建）
    lines.length = 0;
    assert.equal(run({ argv: [t.file], env: { DB_PATH: t.dbPath }, out }), 0);
    assert.match(lines.join('\n'), /\[复用\]/, '库已存在时计划要看真实的库，不能凭空说全是新的');
    assert.match(lines.join('\n'), /其中 2 件已存在会跳过/);

    // 再跑一次：应当全是跳过，物品数量不变
    lines.length = 0;
    assert.equal(run({ argv: [t.file, '--yes'], env: { DB_PATH: t.dbPath }, out }), 0);
    assert.match(lines.join('\n'), /跳过已存在 2 件/);

    const db2 = openMigrated(t.dbPath);
    try {
      const repo = createSqliteRepository(db2);
      assert.equal(repo.listItems(repo.getActiveEvent().id).length, 2, '重跑不该多出物品');
      assert.equal(repo.listEvents().length, 1, '重跑不该多出活动');
    } finally { db2.close(); }
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test('init-event：配置有问题时报错要能看懂，而不是抛一堆栈', () => {
  const t = tempConfig('{ 这不是 json');
  try {
    const errs = [];
    assert.equal(run({ argv: [t.file], env: { DB_PATH: t.dbPath }, out: () => {}, err: (s) => errs.push(s) }), 1);
    assert.match(errs.join('\n'), /不是合法的 JSON/);
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }

  const missing = tempConfig(sampleConfig());
  const gone = path.join(missing.dir, '不存在.json');
  try {
    const errs = [];
    assert.equal(run({ argv: [gone], env: { DB_PATH: missing.dbPath }, out: () => {}, err: (s) => errs.push(s) }), 1);
    assert.match(errs.join('\n'), /找不到配置文件/);
  } finally {
    fs.rmSync(missing.dir, { recursive: true, force: true });
  }

  const bad = tempConfig({ event: { name: '' } });
  try {
    const errs = [];
    assert.equal(run({ argv: [bad.file], env: { DB_PATH: bad.dbPath }, out: () => {}, err: (s) => errs.push(s) }), 1);
    assert.match(errs.join('\n'), /event\.name 必填/);
    assert.ok(!fs.existsSync(bad.dbPath), '配置不合法时不该碰数据库');
  } finally {
    fs.rmSync(bad.dir, { recursive: true, force: true });
  }
});

test('init-event：--help 和缺参数', () => {
  const lines = [];
  assert.equal(run({ argv: ['--help'], out: (s) => lines.push(s) }), 0);
  assert.match(lines.join('\n'), /用法/);

  lines.length = 0;
  const errs = [];
  assert.equal(run({ argv: [], out: (s) => lines.push(s), err: (s) => errs.push(s) }), 1,
    '不给配置文件应当是非零退出 —— 免得被当成「跑成功了」');
  assert.match(lines.join('\n'), /用法/);

  lines.length = 0;
  assert.equal(run({ argv: ['--乱写'], out: (s) => lines.push(s), err: (s) => errs.push(s) }), 1);
  assert.match(errs.join('\n'), /不认识的参数/);
});

/* ============================================================
   ★ 端到端：脚本 + 服务

   上面那些测的是「脚本写进库里的东西对不对」，这条测的是
   「学生那头真的看得到、定得到」—— 也就是「线上库是空的」那个问题的完整链路。
   ============================================================ */

test('init-event：脚本建完，起服务就能查到，学生能直接预定', async () => {
  const t = tempConfig(sampleConfig());
  let srv = null;
  try {
    assert.equal(run({ argv: [t.file, '--yes'], env: { DB_PATH: t.dbPath }, out: () => {} }), 0);

    srv = await startServer({
      port: 0, dbPath: t.dbPath, secret: 'init-e2e-secret-16chars', log: () => {},
      sessions: createFakeSessionProvider({ 'code-student': 'op-student' }),
    });
    const base = `http://127.0.0.1:${srv.port}`;
    const getJson = async (p) => (await fetch(base + p)).json();

    /* ---------- 活动 ---------- */
    const ev = await getJson('/api/event');
    assert.equal(ev.ok, true);
    assert.equal(ev.event.name, '檐下猫小记 · 闲置物品登记');
    assert.equal(ev.stalls.length, 2);
    // 首页要拿这两个时间显示「9:00–17:00」，所以必须是正确的绝对时刻
    assert.equal(new Date(ev.event.startsAt).toISOString(), '2026-04-18T01:00:00.000Z');
    assert.equal(new Date(ev.event.endsAt).toISOString(), '2026-04-18T09:00:00.000Z');

    /* ---------- 物品 ---------- */
    const list = await getJson('/api/items');
    assert.equal(list.items.length, 2, '脚本建的物品学生必须看得到');

    const cookie = list.items.find((x) => x.name === '手作黄油曲奇');
    assert.equal(cookie.remainingQuota, 12);
    assert.equal(cookie.totalQuota, 12);
    assert.equal(cookie.status, 'on_sale');
    assert.equal(cookie.emoji, '🍪');
    assert.equal(cookie.tint, 't-yellow');
    assert.equal(cookie.stallName, '一号摊位 · 手作烘焙', '摊位要能对上');

    /* ---------- 登录 → 登记 → 预定 ---------- */
    const login = await (await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'code-student' }),
    })).json();
    assert.equal(login.ok, true, JSON.stringify(login));

    const reg = await (await fetch(base + '/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` },
      body: JSON.stringify({ name: '同学甲' }),
    })).json();
    assert.equal(reg.ok, true, JSON.stringify(reg));

    const reserved = await (await fetch(base + '/api/reserve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ itemId: cookie.id, requestId: 'e2e-1' }),
    })).json();
    assert.equal(reserved.ok, true, JSON.stringify(reserved));
    assert.match(reserved.reservation.code, /^\d{6}$/, '要拿得到 6 位取货码');
    assert.equal(reserved.remaining, 11, '名额要跟着扣');

    // 管理端建完物品之后，学生那头也一样能定 —— 两条创建路径出来的数据得是同一种东西
    const admin = await (await fetch(base + '/api/admin/item/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ name: '现场加的东西', totalQuota: 3, stallId: ev.stalls[0].id }),
    })).json();
    assert.equal(admin.ok, false, '普通学生不该能新建物品');
    assert.equal(admin.error, 'forbidden');
  } finally {
    if (srv) await srv.close();
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

/* ============================================================
   仓库里的示例配置必须能用
   ============================================================ */

test('init-event：仓库里的示例配置是合法的', () => {
  const file = new URL('../deploy/event-config.example.json', import.meta.url);
  const cfg = parseConfig(JSON.parse(fs.readFileSync(file, 'utf8')));

  assert.ok(cfg.stalls.length >= 1, '示例至少要有摊位，否则物品没法挂');
  assert.ok(cfg.items.length >= 1, '示例至少要有物品，否则照抄出来是个空活动');

  // 示例里出现的配色必须是真实存在的类，否则照抄的人第一步就错
  for (const it of cfg.items) assert.ok(ITEM_TINTS.includes(it.tint), it.tint);
});
