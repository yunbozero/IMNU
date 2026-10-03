/**
 * 管理端接口测试：物品 / 撤销核销 / 角色 / 转交 / 名单导出。
 *
 * 权限相关的测试刻意覆盖**越权**而不是只测正常路径 ——
 * 「学生能改别人角色」这种 bug 不会自己冒出来，只能靠测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/http.mjs';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import { createFakeSessionProvider } from '../server/auth.mjs';
import {
  ITEM_NAME_MAX, ITEM_DESC_MAX, ITEM_QUOTA_MAX, ITEM_EMOJI_MAX, ITEM_TINTS,
} from '../server/api.mjs';

const SECRET = 'admin-test-secret-16chars';

/** 预置五个不同角色的人，各有一个 code 换 token */
const PEOPLE = {
  'code-student': { openid: 'op-student', sid: '2021000001', name: '同学甲', role: 'student' },
  'code-vol': { openid: 'op-vol', sid: '2021000002', name: '志愿者', role: 'volunteer' },
  'code-deputy': { openid: 'op-deputy', sid: '2021000003', name: '二级管理员', role: 'deputy' },
  'code-admin': { openid: 'op-admin', sid: '2021000004', name: '一级管理员', role: 'admin' },
  'code-admin2': { openid: 'op-admin2', sid: '2021000005', name: '另一位一级', role: 'admin' },
  'code-owner': { openid: 'op-owner', sid: '2021000006', name: '超管', role: 'owner' },
};

async function startTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-admin-'));
  const dbPath = path.join(dir, 'bazaar.db');

  const db = openMigrated(dbPath);
  const repo = createSqliteRepository(db);
  const ev = repo.createEvent({ name: '测试义卖', status: 'on_sale' });
  const stall = repo.createStall({ eventId: ev.id, name: '一号摊位', loc: '图书馆前' });
  const item = repo.createItem({
    eventId: ev.id, stallId: stall.id, name: '手作黄油曲奇', totalQuota: 10,
  });

  // 先造人但都当学生，再逐个 setUserRole —— 超管走 bootstrapOwner，
  // 因为 setUserRole 明确拒绝直接造超管
  for (const [code, p] of Object.entries(PEOPLE)) {
    const r = repo.createUser({ openid: p.openid, sid: p.sid, name: p.name, role: 'student' });
    p.id = r.user.id;
    void code;
  }
  for (const p of Object.values(PEOPLE)) {
    if (p.role === 'owner') repo.bootstrapOwner(p.id);
    else if (p.role !== 'student') repo.setUserRole(p.id, p.role);
  }
  db.close();

  const srv = await startServer({
    port: 0, dbPath, secret: SECRET, log: () => {},
    sessions: createFakeSessionProvider(
      Object.fromEntries(Object.entries(PEOPLE).map(([code, p]) => [code, p.openid]))
    ),
  });

  const base = `http://127.0.0.1:${srv.port}`;

  // 把 code 换成 token
  const tokens = {};
  for (const code of Object.keys(PEOPLE)) {
    const res = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const body = await res.json();
    assert.equal(body.ok, true, `登录失败：${code}`);
    tokens[code] = body.token;
  }

  return {
    ...srv, dir, base, tokens, ids: { eventId: ev.id, itemId: item.id, stallId: stall.id, people: PEOPLE },
    async close() { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function call(ctx, method, p, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(ctx.base + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });

  // ★ 刻意不用 res.text()：它按 WHATWG 规范会把开头的 BOM 吃掉，
  //   而 BOM 正是我们要验证的东西。Buffer.toString 不会动它。
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString('utf8');

  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON，比如 CSV */ }
  return { status: res.status, body: json, text, bytes, contentType: res.headers.get('content-type') };
}

/* ============================================================
   越权：每个角色都试一遍不该做的事
   ============================================================ */

test('管理端：学生和志愿者一律进不来', async () => {
  const ctx = await startTestServer();
  try {
    const attempts = [
      ['POST', '/api/admin/item', { itemId: ctx.ids.itemId, quotaDelta: 1 }],
      ['POST', '/api/admin/item/create', { name: '偷偷加的', totalQuota: 1 }],
      ['POST', '/api/admin/undo-redeem', { reservationId: 'x' }],
      ['POST', '/api/admin/role', { userId: ctx.ids.people['code-student'].id, role: 'admin' }],
      ['POST', '/api/admin/transfer-owner', { userId: ctx.ids.people['code-student'].id }],
      ['GET', '/api/admin/reservations', undefined],
    ];

    for (const code of ['code-student', 'code-vol']) {
      for (const [method, p, body] of attempts) {
        const r = await call(ctx, method, p, { token: ctx.tokens[code], body });
        assert.equal(r.status, 403, `${code} 访问 ${p} 应当是 403，实际 ${r.status}`);
        assert.equal(r.body.error, 'forbidden');
      }
    }

    // 未登录一律 401
    const anon = await call(ctx, 'GET', '/api/admin/reservations');
    assert.equal(anon.status, 401);
  } finally { await ctx.close(); }
});

/* ============================================================
   物品管理
   ============================================================ */

test('管理端：二级管理员可以改物品', async () => {
  const ctx = await startTestServer();
  try {
    const add = await call(ctx, 'POST', '/api/admin/item', {
      token: ctx.tokens['code-deputy'],
      body: { itemId: ctx.ids.itemId, quotaDelta: 5 },
    });
    assert.equal(add.body.ok, true, JSON.stringify(add.body));
    assert.equal(add.body.item.totalQuota, 15);
    assert.equal(add.body.item.remainingQuota, 15);

    const off = await call(ctx, 'POST', '/api/admin/item', {
      token: ctx.tokens['code-deputy'],
      body: { itemId: ctx.ids.itemId, status: 'off_shelf' },
    });
    assert.equal(off.body.ok, true);
    assert.equal(off.body.item.status, 'off_shelf');
  } finally { await ctx.close(); }
});

test('管理端：下架之后学生就预定不了了', async () => {
  const ctx = await startTestServer();
  try {
    await call(ctx, 'POST', '/api/admin/item', {
      token: ctx.tokens['code-deputy'],
      body: { itemId: ctx.ids.itemId, status: 'off_shelf' },
    });

    const r = await call(ctx, 'POST', '/api/reserve', {
      token: ctx.tokens['code-student'],
      body: { itemId: ctx.ids.itemId, requestId: 'r1' },
    });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, 'off_shelf');
  } finally { await ctx.close(); }
});

test('管理端：改物品的入参错误要明确拒绝', async () => {
  const ctx = await startTestServer();
  try {
    const t = ctx.tokens['code-deputy'];
    const cases = [
      { body: {}, expect: 400 },                                          // 什么都没给
      { body: { itemId: ctx.ids.itemId }, expect: 400 },                  // 没有要改的内容
      { body: { itemId: ctx.ids.itemId, status: '乱写' }, expect: 400 },
      { body: { itemId: ctx.ids.itemId, quotaDelta: 1.5 }, expect: 400 },
      { body: { itemId: 'it_不存在', quotaDelta: 1 }, expect: 404 },
    ];
    for (const c of cases) {
      const r = await call(ctx, 'POST', '/api/admin/item', { token: t, body: c.body });
      assert.equal(r.status, c.expect, `${JSON.stringify(c.body)} 应当 ${c.expect}，实际 ${r.status}`);
    }
  } finally { await ctx.close(); }
});

/* ============================================================
   新建物品（管理端）
   ============================================================ */

/** 一条合法的新建请求。每个用例在它上面只改一处。 */
function newItemBody(over = {}) {
  return {
    name: '手写书签', description: '手写小楷，可自选句子',
    emoji: '🔖', tint: 't-pink', totalQuota: 20,
    ...over,
  };
}

test('管理端：二级管理员可以新建物品，名额从满的开始', async () => {
  const ctx = await startTestServer();
  try {
    const r = await call(ctx, 'POST', '/api/admin/item/create', {
      token: ctx.tokens['code-deputy'],
      body: newItemBody({ stallId: ctx.ids.stallId }),
    });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));

    const it = r.body.item;
    assert.equal(it.name, '手写书签');
    assert.equal(it.totalQuota, 20);
    assert.equal(it.remainingQuota, 20, '新建的物品名额应当是满的');
    assert.equal(it.status, 'on_sale', '建出来就该是在售的');
    assert.equal(it.stallId, ctx.ids.stallId);
    assert.equal(it.eventId, ctx.ids.eventId, '必须挂在当前活动下');

    // ★ 建完学生那头要立刻看得见、定得到 —— 这才是这个接口存在的意义
    const list = (await call(ctx, 'GET', '/api/items')).body.items;
    const mine = list.find((x) => x.id === it.id);
    assert.ok(mine, '新建的物品应当出现在学生看到的列表里');
    assert.equal(mine.stallName, '一号摊位');

    const res = await call(ctx, 'POST', '/api/reserve', {
      token: ctx.tokens['code-student'],
      body: { itemId: it.id, requestId: 'new-1' },
    });
    assert.equal(res.body.ok, true, JSON.stringify(res.body));

    const detail = auditDetail(ctx, 'item.create');
    assert.equal(detail.name, '手写书签');
    assert.equal(detail.totalQuota, 20);
    assert.equal(detail.via, 'admin');
  } finally { await ctx.close(); }
});

test('管理端：新建物品的入参错误要明确拒绝，且不留半成品', async () => {
  const ctx = await startTestServer();
  try {
    const t = ctx.tokens['code-deputy'];
    const cases = [
      [{ name: undefined }, 400],
      [{ name: '' }, 400],
      [{ name: '   ' }, 400],
      [{ name: 'x'.repeat(ITEM_NAME_MAX + 1) }, 400],
      [{ totalQuota: undefined }, 400],
      [{ totalQuota: 0 }, 400],
      [{ totalQuota: -1 }, 400],
      [{ totalQuota: 1.5 }, 400],
      [{ totalQuota: ITEM_QUOTA_MAX + 1 }, 400],
      [{ totalQuota: 'abc' }, 400],
      // 不是数量的东西不能被 Number() 悄悄变成合法值：Number(true) 是 1
      [{ totalQuota: true }, 400],
      [{ totalQuota: [] }, 400],
      [{ tint: 't-乱写' }, 400],
      [{ emoji: 'x'.repeat(ITEM_EMOJI_MAX + 1) }, 400],
      [{ description: 'x'.repeat(ITEM_DESC_MAX + 1) }, 400],
      [{ stallId: 'st_不存在' }, 400],
    ];
    for (const [over, expect] of cases) {
      const r = await call(ctx, 'POST', '/api/admin/item/create', {
        token: t, body: newItemBody(over),
      });
      assert.equal(r.status, expect,
        `${JSON.stringify(over)} 应当 ${expect}，实际 ${r.status}：${JSON.stringify(r.body)}`);
    }

    assert.equal((await call(ctx, 'GET', '/api/items')).body.items.length, 1,
      '参数被拒时不能留下半成品');
  } finally { await ctx.close(); }
});

test('管理端：新建物品的边界值要能过', async () => {
  const ctx = await startTestServer();
  try {
    const t = ctx.tokens['code-deputy'];
    const okCases = [
      { name: 'x', totalQuota: 1 },                                     // 最短名字、最少名额
      { name: '名'.repeat(ITEM_NAME_MAX), totalQuota: ITEM_QUOTA_MAX }, // 最长名字、最多名额
      { name: '没填图标的', totalQuota: 5, emoji: '', tint: '', description: '' },
      { name: '一个 emoji 的', totalQuota: 5, emoji: '🍪' },
      { name: '两个字图标的', totalQuota: 5, emoji: '曲奇' },
      { name: '名额写成字符串的', totalQuota: '7' },   // 输入框给的就是字符串
    ];
    for (const body of okCases) {
      const r = await call(ctx, 'POST', '/api/admin/item/create', { token: t, body });
      assert.equal(r.body.ok, true,
        `${JSON.stringify(body)} 应当能建：${JSON.stringify(r.body)}`);
    }

    const list = (await call(ctx, 'GET', '/api/items')).body.items;
    // '🍪'.length 是 2 —— 拿 length 当上限的话一个 emoji 就会被当成两个字拒掉
    assert.equal(list.find((x) => x.name === '一个 emoji 的').emoji, '🍪');
    // 不填配色要给个默认色，而不是留空让小程序渲染成白块
    assert.ok(ITEM_TINTS.includes(list.find((x) => x.name === '没填图标的').tint));
    assert.equal(list.find((x) => x.name === '没填图标的').emoji, null);
    assert.equal(list.find((x) => x.name === '名额写成字符串的').totalQuota, 7,
      '数字字符串要收 —— 界面输入框给的就是字符串');
  } finally { await ctx.close(); }
});

test('管理端：不能把物品挂到别的活动的摊位上', async () => {
  const ctx = await startTestServer();
  try {
    // 另起一个**草稿**活动 —— 不能建成 on_sale，否则 getActiveEvent 会改用新的那个，
    // 于是这个摊位反而变成"当前活动的摊位"，测不到要测的东西
    const other = ctx.repo.createEvent({ name: '别的活动', status: 'draft' });
    const otherStall = ctx.repo.createStall({ eventId: other.id, name: '二号摊位' });

    const r = await call(ctx, 'POST', '/api/admin/item/create', {
      token: ctx.tokens['code-deputy'],
      body: newItemBody({ stallId: otherStall.id }),
    });
    assert.equal(r.status, 400, '摊位不属于当前活动时必须拒绝');
    assert.match(r.body.message, /摊位/);
  } finally { await ctx.close(); }
});

test('管理端：没有在售活动时不能新建物品', async () => {
  const ctx = await startTestServer();
  try {
    ctx.db.prepare("UPDATE events SET status = 'ended'").run();

    const r = await call(ctx, 'POST', '/api/admin/item/create', {
      token: ctx.tokens['code-deputy'],
      body: newItemBody(),
    });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, 'no_active_event');
    assert.match(r.body.message, /init-event/, '要告诉他去哪儿把活动建起来');
  } finally { await ctx.close(); }
});

/* ============================================================
   撤销核销
   ============================================================ */

test('管理端：二级管理员不能撤销核销，一级可以', async () => {
  const ctx = await startTestServer();
  try {
    // 造一笔已核销的
    const res = await call(ctx, 'POST', '/api/reserve', {
      token: ctx.tokens['code-student'],
      body: { itemId: ctx.ids.itemId, requestId: 'r1' },
    });
    const code = res.body.reservation.code;
    await call(ctx, 'POST', '/api/redeem', { token: ctx.tokens['code-vol'], body: { code } });

    const byDeputy = await call(ctx, 'POST', '/api/admin/undo-redeem', {
      token: ctx.tokens['code-deputy'],
      body: { reservationId: res.body.reservation.id },
    });
    assert.equal(byDeputy.status, 403, '撤销核销要比改物品更严');

    const byAdmin = await call(ctx, 'POST', '/api/admin/undo-redeem', {
      token: ctx.tokens['code-admin'],
      body: { reservationId: res.body.reservation.id },
    });
    assert.equal(byAdmin.body.ok, true, JSON.stringify(byAdmin.body));
    assert.equal(byAdmin.body.reservation.status, 'reserved');
  } finally { await ctx.close(); }
});

/* ============================================================
   角色
   ============================================================ */

test('管理端：一级管理员可以任命二级，也可以任命另一个一级', async () => {
  const ctx = await startTestServer();
  try {
    const t = ctx.tokens['code-admin'];
    const stu = ctx.ids.people['code-vol'].id;

    const r = await call(ctx, 'POST', '/api/admin/role', {
      token: t, body: { userId: stu, role: 'admin' },
    });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.to, 'admin');
  } finally { await ctx.close(); }
});

test('管理端：一级管理员不能撤销另一个一级（防内斗互删）', async () => {
  const ctx = await startTestServer();
  try {
    const r = await call(ctx, 'POST', '/api/admin/role', {
      token: ctx.tokens['code-admin'],
      body: { userId: ctx.ids.people['code-admin2'].id, role: 'volunteer' },
    });
    assert.equal(r.body.ok, false);
    assert.match(r.body.message, /不能撤销/);
  } finally { await ctx.close(); }
});

test('管理端：二级管理员撤销不了一级', async () => {
  const ctx = await startTestServer();
  try {
    const r = await call(ctx, 'POST', '/api/admin/role', {
      token: ctx.tokens['code-deputy'],
      body: { userId: ctx.ids.people['code-admin'].id, role: 'student' },
    });
    assert.equal(r.body.ok, false);
  } finally { await ctx.close(); }
});

test('管理端：谁都不能通过这个接口造超管', async () => {
  const ctx = await startTestServer();
  try {
    for (const code of ['code-owner', 'code-admin', 'code-deputy']) {
      const r = await call(ctx, 'POST', '/api/admin/role', {
        token: ctx.tokens[code],
        body: { userId: ctx.ids.people['code-student'].id, role: 'owner' },
      });
      assert.equal(r.body.ok, false, `${code} 不该能造超管`);
      assert.equal(r.body.error, 'use_transfer');
    }
  } finally { await ctx.close(); }
});

test('管理端：改不了超管的身份，也改不了自己的', async () => {
  const ctx = await startTestServer();
  try {
    const ownerId = ctx.ids.people['code-owner'].id;

    const touchOwner = await call(ctx, 'POST', '/api/admin/role', {
      token: ctx.tokens['code-owner'], body: { userId: ownerId, role: 'admin' },
    });
    assert.equal(touchOwner.body.ok, false);
    assert.equal(touchOwner.body.error, 'owner_immutable');

    const self = await call(ctx, 'POST', '/api/admin/role', {
      token: ctx.tokens['code-admin'],
      body: { userId: ctx.ids.people['code-admin'].id, role: 'deputy' },
    });
    assert.equal(self.body.ok, false);
    assert.equal(self.body.error, 'self_change');
  } finally { await ctx.close(); }
});

test('管理端：超管转交之后，超管仍然只有一个', async () => {
  const ctx = await startTestServer();
  try {
    const r = await call(ctx, 'POST', '/api/admin/transfer-owner', {
      token: ctx.tokens['code-owner'],
      body: { userId: ctx.ids.people['code-admin'].id },
    });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.to.role, 'owner');

    // 旧超管降为一级，不再是超管，也就转交不了了
    const again = await call(ctx, 'POST', '/api/admin/transfer-owner', {
      token: ctx.tokens['code-owner'],
      body: { userId: ctx.ids.people['code-student'].id },
    });
    assert.equal(again.body.ok, false);

    // 新超管可以转
    const byNew = await call(ctx, 'POST', '/api/admin/transfer-owner', {
      token: ctx.tokens['code-admin'],
      body: { userId: ctx.ids.people['code-owner'].id },
    });
    assert.equal(byNew.body.ok, true);
  } finally { await ctx.close(); }
});

test('管理端：非超管转交被拒（403）', async () => {
  const ctx = await startTestServer();
  try {
    const r = await call(ctx, 'POST', '/api/admin/transfer-owner', {
      token: ctx.tokens['code-admin'],
      body: { userId: ctx.ids.people['code-student'].id },
    });
    assert.equal(r.status, 403);
  } finally { await ctx.close(); }
});

/* ============================================================
   名单导出
   ============================================================ */

test('管理端：名单带物品名和取货人，且带导出的 CSV', async () => {
  const ctx = await startTestServer();
  try {
    await call(ctx, 'POST', '/api/reserve', {
      token: ctx.tokens['code-student'],
      body: { itemId: ctx.ids.itemId, requestId: 'r1', qty: 2 },
    });

    const json = await call(ctx, 'GET', '/api/admin/reservations', {
      token: ctx.tokens['code-deputy'],
    });
    assert.equal(json.body.ok, true);
    assert.equal(json.body.total, 1);
    assert.equal(json.body.reservations[0].itemName, '手作黄油曲奇');
    assert.equal(json.body.reservations[0].userName, '同学甲');

    const csv = await call(ctx, 'GET', '/api/admin/reservations?format=csv', {
      token: ctx.tokens['code-deputy'],
    });
    assert.match(csv.contentType, /text\/csv/);
    assert.deepEqual([...csv.bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF],
      'CSV 必须以 UTF-8 BOM 开头，否则 Excel 打开中文是乱码 —— 而这份文件就是拿去打印的');
    assert.match(csv.text, /取货码,物品,数量,取货人,学号,状态/);
    assert.match(csv.text, /手作黄油曲奇/);
    assert.match(csv.text, /同学甲/);
    assert.match(csv.text, /2021000001/);
  } finally { await ctx.close(); }
});

test('管理端：导出的名单里不能有任何金额列', async () => {
  const ctx = await startTestServer();
  try {
    const csv = await call(ctx, 'GET', '/api/admin/reservations?format=csv', {
      token: ctx.tokens['code-deputy'],
    });
    const header = csv.text.split('\r\n')[0];
    for (const banned of ['金额', '价格', '元', '费用', 'payment', 'price', 'amount']) {
      assert.ok(!header.includes(banned), `表头不该出现「${banned}」：${header}`);
    }
  } finally { await ctx.close(); }
});

test('管理端：名单可以按状态过滤', async () => {
  const ctx = await startTestServer();
  try {
    const a = await call(ctx, 'POST', '/api/reserve', {
      token: ctx.tokens['code-student'],
      body: { itemId: ctx.ids.itemId, requestId: 'r1' },
    });
    await call(ctx, 'POST', '/api/reserve', {
      token: ctx.tokens['code-vol'],
      body: { itemId: ctx.ids.itemId, requestId: 'r2' },
    });
    await call(ctx, 'POST', '/api/cancel', {
      token: ctx.tokens['code-student'],
      body: { reservationId: a.body.reservation.id },
    });

    const all = await call(ctx, 'GET', '/api/admin/reservations', {
      token: ctx.tokens['code-deputy'],
    });
    assert.equal(all.body.total, 2);

    const reserved = await call(ctx, 'GET', '/api/admin/reservations?status=reserved', {
      token: ctx.tokens['code-deputy'],
    });
    assert.equal(reserved.body.total, 1);

    const cancelled = await call(ctx, 'GET', '/api/admin/reservations?status=cancelled', {
      token: ctx.tokens['code-deputy'],
    });
    assert.equal(cancelled.body.total, 1);
  } finally { await ctx.close(); }
});

/* ============================================================
   管理端取消别人的预定
   ============================================================ */

/** 让某个人预定那件物品，返回 reservation */
async function reserveAs(ctx, token, requestId) {
  const r = await call(ctx, 'POST', '/api/reserve', {
    token, body: { itemId: ctx.ids.itemId, requestId },
  });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  return r.body.reservation;
}

/** 取最后一条某类操作日志的 detail */
function auditDetail(ctx, action) {
  const row = ctx.db.prepare(
    'SELECT detail FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1'
  ).get(action);
  return row ? JSON.parse(row.detail || '{}') : null;
}

test('管理端：副主任可以取消别人的预定，名额释放，原因进日志', async () => {
  const ctx = await startTestServer();
  try {
    const before = (await call(ctx, 'GET', '/api/items')).body.items[0].remainingQuota;

    const r = await reserveAs(ctx, ctx.tokens['code-student'], 'adc-1');
    const afterReserve = (await call(ctx, 'GET', '/api/items')).body.items[0].remainingQuota;
    assert.equal(afterReserve, before - 1, '预定后名额应当减一');

    const res = await call(ctx, 'POST', '/api/admin/cancel', {
      token: ctx.tokens['code-deputy'],
      body: { reservationId: r.id, reason: '本人联系不上' },
    });
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    assert.equal(res.body.released, 1);

    // ★ 名额必须回到预定前。这条测的是「复用了 cancelReservation 的回滚」，
    //   要是谁另写一条 UPDATE 而忘了加名额，这里立刻红。
    const after = (await call(ctx, 'GET', '/api/items')).body.items[0].remainingQuota;
    assert.equal(after, before, '取消后名额必须回到预定前');

    const detail = auditDetail(ctx, 'reservation.admin_cancel');
    assert.equal(detail.reason, '本人联系不上', '原因必须进操作日志');
    assert.equal(detail.code, r.code, '日志里要留取货码，方便对账');
    assert.equal(detail.targetUserId, ctx.ids.people['code-student'].id,
      '要记下被取消的是谁 —— 同学来问时才查得到');
  } finally { await ctx.close(); }
});

test('管理端：学生和志愿者不能取消别人的预定', async () => {
  const ctx = await startTestServer();
  try {
    const r = await reserveAs(ctx, ctx.tokens['code-student'], 'adc-2');

    for (const code of ['code-student', 'code-vol']) {
      const res = await call(ctx, 'POST', '/api/admin/cancel', {
        token: ctx.tokens[code], body: { reservationId: r.id, reason: '试试看' },
      });
      assert.equal(res.status, 403, `${code} 不该能取消别人的预定`);
    }

    // 越权调用不能有任何副作用
    const left = (await call(ctx, 'GET', '/api/items')).body.items[0].remainingQuota;
    assert.equal(left, 9, '越权失败时名额不该被释放');
  } finally { await ctx.close(); }
});

test('管理端：取消必须给原因，且长度受限', async () => {
  const ctx = await startTestServer();
  try {
    const r = await reserveAs(ctx, ctx.tokens['code-student'], 'adc-3');

    for (const reason of [undefined, '', '   ', 'x', 'x'.repeat(61)]) {
      const res = await call(ctx, 'POST', '/api/admin/cancel', {
        token: ctx.tokens['code-deputy'],
        body: { reservationId: r.id, reason },
      });
      assert.equal(res.status, 400, `原因「${reason}」应当被拒`);
    }

    // 参数不合法时不能改动任何东西
    const mine = (await call(ctx, 'GET', '/api/reservations', { token: ctx.tokens['code-student'] }))
      .body.reservations[0];
    assert.equal(mine.status, 'reserved', '参数被拒时预定还是原样');
  } finally { await ctx.close(); }
});

test('管理端：已核销的要先撤销核销，不能直接取消', async () => {
  const ctx = await startTestServer();
  try {
    const r = await reserveAs(ctx, ctx.tokens['code-student'], 'adc-4');
    const ok = await call(ctx, 'POST', '/api/redeem', {
      token: ctx.tokens['code-vol'], body: { code: r.code },
    });
    assert.equal(ok.body.ok, true, JSON.stringify(ok.body));

    const res = await call(ctx, 'POST', '/api/admin/cancel', {
      token: ctx.tokens['code-deputy'],
      body: { reservationId: r.id, reason: '想取消' },
    });
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'already_redeemed');
    assert.match(res.body.message, /撤销核销/, '要明确告诉他下一步该做什么');
  } finally { await ctx.close(); }
});

test('管理端：取消不存在的预定返回 404', async () => {
  const ctx = await startTestServer();
  try {
    const res = await call(ctx, 'POST', '/api/admin/cancel', {
      token: ctx.tokens['code-deputy'],
      body: { reservationId: 'rsv_不存在', reason: '测试' },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'not_found');
  } finally { await ctx.close(); }
});

/* ============================================================
   运行期设置：每账号预定上限
   ============================================================ */

/** 再放一件物品进来 —— 只有一件时「一人一件」会先把人拦住，测不出上限 */
function addExtraItem(ctx, totalQuota = 10) {
  return ctx.repo.createItem({
    eventId: ctx.ids.eventId, name: '多肉小盆栽', totalQuota,
  });
}

const getSettings = (ctx, token) => call(ctx, 'GET', '/api/admin/settings', { token });
const setSettings = (ctx, token, maxItemsPerUser) => call(ctx, 'POST', '/api/admin/settings', {
  token, body: { maxItemsPerUser },
});

test('设置：只有一级管理员及以上能读能改', async () => {
  const ctx = await startTestServer();
  try {
    for (const code of ['code-student', 'code-vol', 'code-deputy']) {
      assert.equal((await getSettings(ctx, ctx.tokens[code])).status, 403,
        `${code} 不该能读设置`);
      assert.equal((await setSettings(ctx, ctx.tokens[code], 1)).status, 403,
        `${code} 不该能改设置`);
    }
    for (const code of ['code-admin', 'code-owner']) {
      assert.equal((await getSettings(ctx, ctx.tokens[code])).body.ok, true,
        `${code} 应当能读设置`);
    }
  } finally { await ctx.close(); }
});

test('设置：上限必须是 0–100 的整数', async () => {
  const ctx = await startTestServer();
  try {
    for (const bad of [-1, 1.5, 101, 'abc', undefined]) {
      const r = await setSettings(ctx, ctx.tokens['code-admin'], bad);
      assert.equal(r.status, 400, `上限「${bad}」应当被拒`);
    }
    // 边界值要能过：0 = 不限，100 = 允许的最大值
    for (const good of [0, 100]) {
      const r = await setSettings(ctx, ctx.tokens['code-admin'], good);
      assert.equal(r.body.ok, true, `上限 ${good} 应当能设`);
    }
  } finally { await ctx.close(); }
});

test('设置：★ 改完下一笔预定就生效（不用重启服务）', async () => {
  const ctx = await startTestServer();
  try {
    const extra = addExtraItem(ctx);
    const t = ctx.tokens['code-student'];

    // 测试服务器没传上限 → 默认不限。先定一件。
    const a = await call(ctx, 'POST', '/api/reserve', {
      token: t, body: { itemId: ctx.ids.itemId, requestId: 'set-1' },
    });
    assert.equal(a.body.ok, true, JSON.stringify(a.body));

    // 管理员把上限改成 1：已经拿了 1 件，下一件必须被拦住
    assert.equal((await setSettings(ctx, ctx.tokens['code-admin'], 1)).body.ok, true);

    const b = await call(ctx, 'POST', '/api/reserve', {
      token: t, body: { itemId: extra.id, requestId: 'set-2' },
    });
    assert.equal(b.body.ok, false, '改完应当立刻拦住下一笔');
    assert.equal(b.body.error, 'too_many');

    // 放宽到 3：立刻又能定
    assert.equal((await setSettings(ctx, ctx.tokens['code-admin'], 3)).body.ok, true);

    const c = await call(ctx, 'POST', '/api/reserve', {
      token: t, body: { itemId: extra.id, requestId: 'set-3' },
    });
    assert.equal(c.body.ok, true, `放宽后应当立刻能定：${JSON.stringify(c.body)}`);
  } finally { await ctx.close(); }
});

test('设置：调低上限不会取消已有的预定', async () => {
  const ctx = await startTestServer();
  try {
    const extra = addExtraItem(ctx);
    const t = ctx.tokens['code-student'];

    await call(ctx, 'POST', '/api/reserve', {
      token: t, body: { itemId: ctx.ids.itemId, requestId: 'low-1' },
    });
    await call(ctx, 'POST', '/api/reserve', {
      token: t, body: { itemId: extra.id, requestId: 'low-2' },
    });

    // 压到 1 件
    await setSettings(ctx, ctx.tokens['code-admin'], 1);

    const mine = (await call(ctx, 'GET', '/api/reservations', { token: t }))
      .body.reservations.filter((x) => x.status === 'reserved');
    assert.equal(mine.length, 2, '调低上限不该动别人已经锁定的名额');
  } finally { await ctx.close(); }
});

test('设置：能恢复默认，且改动进操作日志', async () => {
  const ctx = await startTestServer();
  try {
    const admin = ctx.tokens['code-admin'];

    const before = (await getSettings(ctx, admin)).body;
    assert.equal(before.overridden, false, '一开始应当是默认值，没有被改过');
    assert.equal(before.maxItemsPerUser, before.defaultMaxItemsPerUser);

    await setSettings(ctx, admin, 7);

    const mid = (await getSettings(ctx, admin)).body;
    assert.equal(mid.maxItemsPerUser, 7);
    assert.equal(mid.overridden, true);

    const detail = auditDetail(ctx, 'settings.update');
    assert.equal(detail.from, before.maxItemsPerUser, '日志要记下改之前的值');
    assert.equal(detail.to, 7);
    assert.equal(detail.key, 'maxItemsPerUser');

    // 传 null = 恢复默认
    const reset = await setSettings(ctx, admin, null);
    assert.equal(reset.body.ok, true);
    assert.equal(reset.body.overridden, false);

    const after = (await getSettings(ctx, admin)).body;
    assert.equal(after.maxItemsPerUser, after.defaultMaxItemsPerUser, '应当回到兜底值');
    assert.equal(after.overridden, false);
  } finally { await ctx.close(); }
});
