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
    ...srv, dir, base, tokens, ids: { eventId: ev.id, itemId: item.id, people: PEOPLE },
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
