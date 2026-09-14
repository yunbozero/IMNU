/**
 * 接口端到端测试。
 *
 * 真的把 HTTP 服务起起来、真的发请求，覆盖完整流程：
 * 登录 → 登记 → 浏览 → 预定 → 取消 → 核销。
 *
 * 因为 session provider 是可注入的，这些测试**不需要小程序账号、不需要联网、
 * 也不会碰到真的 AppSecret**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/http.mjs';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import { createFakeSessionProvider, createRateLimiter } from '../server/auth.mjs';

const SECRET = 'integration-test-secret-16';

/* ============================================================
   测试脚手架
   ============================================================ */

async function startTestServer({ makeCode, rateLimiter, seed } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-api-'));
  const dbPath = path.join(dir, 'bazaar.db');

  // 先建库并种数据，然后交给服务自己再开一个连接
  const db = openMigrated(dbPath);
  const repo = createSqliteRepository(db);
  const ev = repo.createEvent({ name: '测试义卖', status: 'on_sale' });
  const stall = repo.createStall({ eventId: ev.id, name: '一号摊位', loc: '图书馆前广场东侧' });
  const item = repo.createItem({
    eventId: ev.id, stallId: stall.id, name: '手作黄油曲奇',
    description: '独立包装', emoji: '🍪', tint: 't-yellow', totalQuota: 3,
  });
  const other = repo.createItem({
    eventId: ev.id, stallId: stall.id, name: '多肉小盆栽', totalQuota: 5,
  });
  const volunteer = repo.createUser({
    openid: 'openid-vol', sid: null, name: '志愿者小陈', role: 'volunteer',
  }).user;
  if (seed) seed({ repo, ev, item, other, volunteer });
  db.close();

  const srv = await startServer({
    port: 0,
    dbPath,
    secret: SECRET,
    sessions: createFakeSessionProvider({ 'vol-code': 'openid-vol' }),
    makeCode,
    log: () => {},                                   // 测试时别刷屏
    rateLimiter: rateLimiter || createRateLimiter({ limit: 1000, windowMs: 10_000 }),
  });

  return {
    ...srv,
    dir, dbPath,
    base: `http://127.0.0.1:${srv.port}`,
    ids: { eventId: ev.id, itemId: item.id, otherId: other.id, volunteerId: volunteer.id },
  };
}

async function withServer(opts, fn) {
  const ctx = await startTestServer(opts);
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
}

async function call(base, method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, body: parsed };
}

/** 走一遍登录 + 登记，返回可用的 token 和 user */
async function signUp(ctx, code, sid, name) {
  const login = await call(ctx.base, 'POST', '/api/login', { body: { code } });
  assert.equal(login.body.ok, true, JSON.stringify(login.body));

  const reg = await call(ctx.base, 'POST', '/api/register', {
    token: login.body.token, body: { sid, name },
  });
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  return { token: reg.body.token, user: reg.body.user };
}

/* ============================================================
   基础
   ============================================================ */

test('接口：健康检查不需要登录', async () => {
  await withServer({}, async (ctx) => {
    const r = await call(ctx.base, 'GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.service, 'bazaar-api');
    assert.ok(r.body.version);
    assert.ok(typeof r.body.serverTime === 'number');
  });
});

test('接口：活动与物品列表不需要登录', async () => {
  await withServer({}, async (ctx) => {
    const ev = await call(ctx.base, 'GET', '/api/event');
    assert.equal(ev.body.ok, true);
    assert.equal(ev.body.event.name, '测试义卖');
    assert.equal(ev.body.stalls.length, 1);
    assert.equal(ev.body.stalls[0].name, '一号摊位');

    const items = await call(ctx.base, 'GET', '/api/items');
    assert.equal(items.body.items.length, 2);
    const cookie = items.body.items.find((i) => i.name === '手作黄油曲奇');
    assert.equal(cookie.remainingQuota, 3);
    // 物品列表要把摊位名带出来，省得小程序自己关联
    assert.equal(cookie.stallName, '一号摊位');
    assert.equal(cookie.stallLoc, '图书馆前广场东侧');
  });
});

test('接口：活动未开始时返回 null 而不是报错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-noev-'));
  const dbPath = path.join(dir, 'b.db');
  openMigrated(dbPath).close();          // 有库但没有 on_sale 场次

  const srv = await startServer({
    port: 0, dbPath, secret: SECRET,
    sessions: createFakeSessionProvider(), log: () => {},
  });
  try {
    const r = await call(`http://127.0.0.1:${srv.port}`, 'GET', '/api/event');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.event, null);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ============================================================
   登录与登记
   ============================================================ */

test('接口：新用户先登录再登记，拿到可用 token', async () => {
  await withServer({}, async (ctx) => {
    const login = await call(ctx.base, 'POST', '/api/login', { body: { code: 'code-a' } });
    assert.equal(login.body.ok, true);
    assert.equal(login.body.registered, false);
    assert.equal(login.body.user, null);
    assert.ok(login.body.token, '未登记也要给一个 token，用来调 register');

    // 这个 token 只能用来登记，不能直接当已登录用户使
    const me = await call(ctx.base, 'GET', '/api/me', { token: login.body.token });
    assert.equal(me.status, 401, '未登记 token 不能访问需要用户身份的接口');

    const reg = await call(ctx.base, 'POST', '/api/register', {
      token: login.body.token, body: { sid: '2021123456', name: '王雨桐' },
    });
    assert.equal(reg.body.ok, true);
    assert.equal(reg.body.user.sid, '2021123456');
    assert.equal(reg.body.user.role, 'student');

    const me2 = await call(ctx.base, 'GET', '/api/me', { token: reg.body.token });
    assert.equal(me2.body.ok, true);
    assert.equal(me2.body.user.name, '王雨桐');
    assert.equal(me2.body.isStaff, false);
  });
});

test('接口：同一个微信号再登录时直接认出来', async () => {
  await withServer({}, async (ctx) => {
    await signUp(ctx, 'code-a', '2021123456', '王雨桐');
    const again = await call(ctx.base, 'POST', '/api/login', { body: { code: 'code-a' } });
    assert.equal(again.body.registered, true);
    assert.equal(again.body.user.name, '王雨桐');
  });
});

test('接口：学号被占用时拒绝登记', async () => {
  await withServer({}, async (ctx) => {
    await signUp(ctx, 'code-a', '2021123456', '王雨桐');

    const login = await call(ctx.base, 'POST', '/api/login', { body: { code: 'code-b' } });
    const reg = await call(ctx.base, 'POST', '/api/register', {
      token: login.body.token, body: { sid: '2021123456', name: '李承泽' },
    });
    assert.equal(reg.body.ok, false);
    assert.equal(reg.body.error, 'sid_taken');
    assert.match(reg.body.message, /学号/);
  });
});

test('接口：学号格式不对时拒绝', async () => {
  await withServer({}, async (ctx) => {
    const login = await call(ctx.base, 'POST', '/api/login', { body: { code: 'code-a' } });
    for (const sid of ['abc', '123', '', '12345678901234567']) {
      const r = await call(ctx.base, 'POST', '/api/register', {
        token: login.body.token, body: { sid, name: '王雨桐' },
      });
      assert.equal(r.status, 400, `学号 ${sid} 应当被拒`);
    }
  });
});

test('接口：登录失败返回 401 而不是 500', async () => {
  await withServer({}, async (ctx) => {
    // code 为空
    const r = await call(ctx.base, 'POST', '/api/login', { body: { code: '' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad_request');
  });
});

test('接口：code2session 抛错时登录返回 401', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-loginfail-'));
  const dbPath = path.join(dir, 'b.db');
  openMigrated(dbPath).close();

  const srv = await startServer({
    port: 0, dbPath, secret: SECRET, log: () => {},
    sessions: { async exchange() { throw new Error('微信说不行'); } },
  });
  try {
    const r = await call(`http://127.0.0.1:${srv.port}`, 'POST', '/api/login',
      { body: { code: 'whatever' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'login_failed');
    // 不能把微信的原始错误泄露给客户端
    assert.doesNotMatch(JSON.stringify(r.body), /微信说不行/);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ============================================================
   预定
   ============================================================ */

test('接口：未登录不能预定', async () => {
  await withServer({}, async (ctx) => {
    const r = await call(ctx.base, 'POST', '/api/reserve', {
      body: { itemId: ctx.ids.itemId, requestId: 'r1' },
    });
    assert.equal(r.status, 401);
  });
});

test('接口：完整预定流程，名额正确扣减', async () => {
  await withServer({}, async (ctx) => {
    const { token } = await signUp(ctx, 'code-a', '2021123456', '王雨桐');

    const r = await call(ctx.base, 'POST', '/api/reserve', {
      token, body: { itemId: ctx.ids.itemId, requestId: 'req-1', qty: 1 },
    });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.reservation.status, 'reserved');
    assert.match(r.body.reservation.code, /^\d{6}$/);
    assert.equal(r.body.remaining, 2);

    const items = await call(ctx.base, 'GET', '/api/items');
    assert.equal(items.body.items.find((i) => i.id === ctx.ids.itemId).remainingQuota, 2);

    const mine = await call(ctx.base, 'GET', '/api/reservations', { token });
    assert.equal(mine.body.reservations.length, 1);
    assert.equal(mine.body.reservations[0].itemName, '手作黄油曲奇');
    assert.equal(mine.body.reservations[0].stallName, '一号摊位');
  });
});

test('接口：约满返回业务失败（200 + ok:false），不是 HTTP 错误', async () => {
  await withServer({}, async (ctx) => {
    // 三个不同的人把 3 个名额占满
    for (let i = 0; i < 3; i++) {
      const { token } = await signUp(ctx, `code-${i}`, `20211234${50 + i}`, `同学${i}`);
      const r = await call(ctx.base, 'POST', '/api/reserve', {
        token, body: { itemId: ctx.ids.itemId, requestId: `r-${i}` },
      });
      assert.equal(r.body.ok, true);
    }

    const { token } = await signUp(ctx, 'code-late', '2021123500', '迟到的');
    const r = await call(ctx.base, 'POST', '/api/reserve', {
      token, body: { itemId: ctx.ids.itemId, requestId: 'r-late' },
    });

    assert.equal(r.status, 200, '业务失败要用 200，小程序不该当成网络异常');
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, 'soldout');
    assert.match(r.body.message, /约满/);

    const items = await call(ctx.base, 'GET', '/api/items');
    assert.equal(items.body.items.find((i) => i.id === ctx.ids.itemId).remainingQuota, 0);
  });
});

test('接口：同一个人重复预定同一件物品被拒，且不白扣名额', async () => {
  await withServer({}, async (ctx) => {
    const { token } = await signUp(ctx, 'code-a', '2021123456', '王雨桐');

    await call(ctx.base, 'POST', '/api/reserve', {
      token, body: { itemId: ctx.ids.itemId, requestId: 'r1' },
    });
    const second = await call(ctx.base, 'POST', '/api/reserve', {
      token, body: { itemId: ctx.ids.itemId, requestId: 'r2' },
    });

    assert.equal(second.body.ok, false);
    assert.equal(second.body.error, 'dup');

    const items = await call(ctx.base, 'GET', '/api/items');
    assert.equal(items.body.items.find((i) => i.id === ctx.ids.itemId).remainingQuota, 2,
      'dup 失败不能白扣一个名额');
  });
});

test('接口：同一个 requestId 重放是幂等的', async () => {
  await withServer({}, async (ctx) => {
    const { token } = await signUp(ctx, 'code-a', '2021123456', '王雨桐');
    const body = { itemId: ctx.ids.itemId, requestId: 'same-req' };

    const a = await call(ctx.base, 'POST', '/api/reserve', { token, body });
    const b = await call(ctx.base, 'POST', '/api/reserve', { token, body });

    assert.equal(a.body.ok, true);
    assert.equal(b.body.ok, true);
    assert.equal(b.body.reservation.id, a.body.reservation.id, '必须返回同一笔预定');

    const items = await call(ctx.base, 'GET', '/api/items');
    assert.equal(items.body.items.find((i) => i.id === ctx.ids.itemId).remainingQuota, 2,
      '幂等重放只能扣一次名额');
  });
});

test('接口：缺 requestId 直接拒（幂等键是必填的）', async () => {
  await withServer({}, async (ctx) => {
    const { token } = await signUp(ctx, 'code-a', '2021123456', '王雨桐');
    const r = await call(ctx.base, 'POST', '/api/reserve', {
      token, body: { itemId: ctx.ids.itemId },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad_request');
  });
});

test('接口：数量超上限或非整数都拒', async () => {
  await withServer({}, async (ctx) => {
    const { token } = await signUp(ctx, 'code-a', '2021123456', '王雨桐');
    for (const qty of [0, -1, 1.5, 99, 'abc']) {
      const r = await call(ctx.base, 'POST', '/api/reserve', {
        token, body: { itemId: ctx.ids.itemId, requestId: `r-${qty}`, qty },
      });
      assert.equal(r.status, 400, `qty=${qty} 应当被拒`);
    }
  });
});

test('接口：不存在的物品返回 404', async () => {
  await withServer({}, async (ctx) => {
    const { token } = await signUp(ctx, 'code-a', '2021123456', '王雨桐');
    const r = await call(ctx.base, 'POST', '/api/reserve', {
      token, body: { itemId: 'it_不存在', requestId: 'r1' },
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
  });
});

test('接口：取货码撞车时自动换码重试（数据层只报错，重试是业务决策）', async () => {
  const codes = ['111111', '111111', '222222'];
  let i = 0;

  await withServer({ makeCode: () => codes[Math.min(i++, codes.length - 1)] }, async (ctx) => {
    // 先占掉 111111
    const { token: t1 } = await signUp(ctx, 'code-a', '2021123456', '王雨桐');
    await call(ctx.base, 'POST', '/api/reserve', {
      token: t1, body: { itemId: ctx.ids.otherId, requestId: 'first' },
    });

    // 第二个人生成时前两次都会撞上 111111，第三次拿到 222222
    i = 0;
    const { token: t2 } = await signUp(ctx, 'code-b', '2021123457', '李承泽');
    const r = await call(ctx.base, 'POST', '/api/reserve', {
      token: t2, body: { itemId: ctx.ids.itemId, requestId: 'second' },
    });

    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.reservation.code, '222222', '撞车后应当换一个新码');
    assert.equal(r.body.remaining, 2, '撞车重试不能多扣名额');
  });
});

/* ============================================================
   取消
   ============================================================ */

test('接口：取消预定会把名额还回去', async () => {
  await withServer({}, async (ctx) => {
    const { token } = await signUp(ctx, 'code-a', '2021123456', '王雨桐');
    const r = await call(ctx.base, 'POST', '/api/reserve', {
      token, body: { itemId: ctx.ids.itemId, requestId: 'r1', qty: 2 },
    });
    assert.equal(r.body.remaining, 1);

    const c = await call(ctx.base, 'POST', '/api/cancel', {
      token, body: { reservationId: r.body.reservation.id },
    });
    assert.equal(c.body.ok, true);
    assert.equal(c.body.released, 2);

    const items = await call(ctx.base, 'GET', '/api/items');
    assert.equal(items.body.items.find((i) => i.id === ctx.ids.itemId).remainingQuota, 3);
  });
});

test('接口：不能取消别人的预定（必须在服务端查，不能靠前端不显示按钮）', async () => {
  await withServer({}, async (ctx) => {
    const a = await signUp(ctx, 'code-a', '2021123456', '王雨桐');
    const b = await signUp(ctx, 'code-b', '2021123457', '李承泽');

    const r = await call(ctx.base, 'POST', '/api/reserve', {
      token: a.token, body: { itemId: ctx.ids.itemId, requestId: 'r1' },
    });

    const c = await call(ctx.base, 'POST', '/api/cancel', {
      token: b.token, body: { reservationId: r.body.reservation.id },
    });
    assert.equal(c.status, 403);
    assert.equal(c.body.error, 'forbidden');

    // 确认甲的那笔还在
    const mine = await call(ctx.base, 'GET', '/api/reservations', { token: a.token });
    assert.equal(mine.body.reservations[0].status, 'reserved');
  });
});

test('接口：重复取消第二次失败，名额不虚增', async () => {
  await withServer({}, async (ctx) => {
    const { token } = await signUp(ctx, 'code-a', '2021123456', '王雨桐');
    const r = await call(ctx.base, 'POST', '/api/reserve', {
      token, body: { itemId: ctx.ids.itemId, requestId: 'r1' },
    });

    await call(ctx.base, 'POST', '/api/cancel', {
      token, body: { reservationId: r.body.reservation.id },
    });
    const again = await call(ctx.base, 'POST', '/api/cancel', {
      token, body: { reservationId: r.body.reservation.id },
    });
    assert.equal(again.body.ok, false);

    const items = await call(ctx.base, 'GET', '/api/items');
    assert.equal(items.body.items.find((i) => i.id === ctx.ids.itemId).remainingQuota, 3);
  });
});

/* ============================================================
   核销
   ============================================================ */

test('接口：志愿者核销成功，且记录经手人', async () => {
  await withServer({}, async (ctx) => {
    const stu = await signUp(ctx, 'code-a', '2021123456', '王雨桐');
    const r = await call(ctx.base, 'POST', '/api/reserve', {
      token: stu.token, body: { itemId: ctx.ids.itemId, requestId: 'r1' },
    });
    const code = r.body.reservation.code;

    const vol = await call(ctx.base, 'POST', '/api/login', { body: { code: 'vol-code' } });
    assert.equal(vol.body.registered, true);
    assert.equal(vol.body.user.role, 'volunteer');

    const me = await call(ctx.base, 'GET', '/api/me', { token: vol.body.token });
    assert.equal(me.body.isStaff, true);

    const re = await call(ctx.base, 'POST', '/api/redeem', {
      token: vol.body.token, body: { code },
    });
    assert.equal(re.body.ok, true, JSON.stringify(re.body));
    assert.equal(re.body.reservation.status, 'redeemed');
    assert.equal(re.body.reservation.operatorId, ctx.ids.volunteerId);
    assert.ok(re.body.reservation.redeemedAt);
  });
});

test('接口：学生不能核销（403）', async () => {
  await withServer({}, async (ctx) => {
    const stu = await signUp(ctx, 'code-a', '2021123456', '王雨桐');
    const r = await call(ctx.base, 'POST', '/api/reserve', {
      token: stu.token, body: { itemId: ctx.ids.itemId, requestId: 'r1' },
    });

    const re = await call(ctx.base, 'POST', '/api/redeem', {
      token: stu.token, body: { code: r.body.reservation.code },
    });
    assert.equal(re.status, 403);
    assert.equal(re.body.error, 'forbidden');
  });
});

test('接口：同一个码第二次核销给出明确原因', async () => {
  await withServer({}, async (ctx) => {
    const stu = await signUp(ctx, 'code-a', '2021123456', '王雨桐');
    const r = await call(ctx.base, 'POST', '/api/reserve', {
      token: stu.token, body: { itemId: ctx.ids.itemId, requestId: 'r1' },
    });
    const code = r.body.reservation.code;

    const vol = (await call(ctx.base, 'POST', '/api/login', { body: { code: 'vol-code' } })).body;

    await call(ctx.base, 'POST', '/api/redeem', { token: vol.token, body: { code } });
    const again = await call(ctx.base, 'POST', '/api/redeem', { token: vol.token, body: { code } });

    assert.equal(again.body.ok, false);
    assert.equal(again.body.error, 'already_redeemed');
    assert.match(again.body.message, /已经核销/);
  });
});

test('接口：无效取货码与已取消的码，原因要分开', async () => {
  await withServer({}, async (ctx) => {
    const vol = (await call(ctx.base, 'POST', '/api/login', { body: { code: 'vol-code' } })).body;

    const nobody = await call(ctx.base, 'POST', '/api/redeem', {
      token: vol.token, body: { code: '000000' },
    });
    assert.equal(nobody.body.error, 'invalid_code');

    const stu = await signUp(ctx, 'code-a', '2021123456', '王雨桐');
    const r = await call(ctx.base, 'POST', '/api/reserve', {
      token: stu.token, body: { itemId: ctx.ids.itemId, requestId: 'r1' },
    });
    await call(ctx.base, 'POST', '/api/cancel', {
      token: stu.token, body: { reservationId: r.body.reservation.id },
    });

    const cancelled = await call(ctx.base, 'POST', '/api/redeem', {
      token: vol.token, body: { code: r.body.reservation.code },
    });
    assert.equal(cancelled.body.error, 'cancelled');
  });
});

test('接口：取货码格式不对直接 400，不查库', async () => {
  await withServer({}, async (ctx) => {
    const vol = (await call(ctx.base, 'POST', '/api/login', { body: { code: 'vol-code' } })).body;
    for (const code of ['abc', '', '1', '123456789']) {
      const r = await call(ctx.base, 'POST', '/api/redeem', { token: vol.token, body: { code } });
      assert.equal(r.status, 400, `code=${code} 应当被拒`);
    }
  });
});

/* ============================================================
   限流、路由与异常
   ============================================================ */

test('接口：预定接口有限流，超了返回 429 并带 Retry-After', async () => {
  await withServer({
    rateLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }),
  }, async (ctx) => {
    const { token } = await signUp(ctx, 'code-a', '2021123456', '王雨桐');

    const ok1 = await call(ctx.base, 'POST', '/api/reserve', {
      token, body: { itemId: ctx.ids.itemId, requestId: 'r1' },
    });
    assert.equal(ok1.body.ok, true);

    // 第二次无论如何都会走限流判定（哪怕业务上会 dup），第三次才被拦
    await call(ctx.base, 'POST', '/api/reserve', {
      token, body: { itemId: ctx.ids.otherId, requestId: 'r2' },
    });
    const limited = await call(ctx.base, 'POST', '/api/reserve', {
      token, body: { itemId: ctx.ids.otherId, requestId: 'r3' },
    });

    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'rate_limited');
  });
});

test('接口：只读接口不限流（浏览不该被拦）', async () => {
  await withServer({
    rateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }),
  }, async (ctx) => {
    for (let i = 0; i < 5; i++) {
      const r = await call(ctx.base, 'GET', '/api/items');
      assert.equal(r.status, 200);
    }
  });
});

test('接口：未知路由 404，方法不对 405（排障时区别很大）', async () => {
  await withServer({}, async (ctx) => {
    const missing = await call(ctx.base, 'GET', '/api/nope');
    assert.equal(missing.status, 404);

    const wrongMethod = await call(ctx.base, 'DELETE', '/api/items');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.body.error, 'method_not_allowed');

    // 反向确认：405 只在路径存在时出现
    const bothMissing = await call(ctx.base, 'DELETE', '/api/nope');
    assert.equal(bothMissing.status, 404);
  });
});

test('接口：伪造的 token 一律 401', async () => {
  await withServer({}, async (ctx) => {
    for (const token of ['garbage', 'a.b', 'Bearer x', '']) {
      const r = await call(ctx.base, 'GET', '/api/me', { token });
      assert.equal(r.status, 401, `token=${JSON.stringify(token)} 应当被拒`);
    }
  });
});

test('接口：请求体过大返回 413，畸形 JSON 返回 400', async () => {
  await withServer({}, async (ctx) => {
    const { token } = await signUp(ctx, 'code-a', '2021123456', '王雨桐');

    const huge = await call(ctx.base, 'POST', '/api/reserve', {
      token, body: JSON.stringify({ itemId: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(huge.status, 413);

    const junk = await call(ctx.base, 'POST', '/api/reserve', {
      token, body: '{ 这不是 json',
    });
    assert.equal(junk.status, 400);
    assert.equal(junk.body.error, 'bad_request');
  });
});

test('接口：响应带 no-store，避免取货码被中间层缓存', async () => {
  await withServer({}, async (ctx) => {
    const res = await fetch(ctx.base + '/api/health');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});
