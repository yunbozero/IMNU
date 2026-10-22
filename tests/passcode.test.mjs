/**
 * 活动口令 + 未取货降权。
 *
 * 这两条都挂在「预定」这一个动作上（`/api/reserve`），所以放在一起测：
 *   口令   —— 挡住「不知道这场的口令」的人（校外、无关人员）
 *   降权   —— 上一场预定了没来取的，本场最多约 1 件（不是禁定）
 *
 * 直接调 api 层而不是起 HTTP：这两条是业务规则，鉴权/传输已经有别的测试守着。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import { createApi } from '../server/api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(p, 'utf8');

let codeSeq = 0;

/**
 * 一套最小环境：一个活动（可带口令）+ 一个摊位 + 一件物品 + 一个学生。
 * `now` 注入成可控时钟，用来测「锁 1 小时」。
 */
function fixture({ passCode = null, maxItemsPerUser = 10 } = {}) {
  const db = openMigrated(':memory:');
  const repo = createSqliteRepository(db);
  const clock = { t: Date.UTC(2026, 3, 18, 1, 0) };

  const api = createApi({
    repo,
    secret: 'test-secret-0123456789abcdef',
    signToken: () => 'token',
    makeCode: () => String(100000 + (++codeSeq)),
    maxItemsPerUser,
    now: () => clock.t,
  });

  const event = repo.createEvent({ name: '春季场', status: 'on_sale', passCode });
  const stall = repo.createStall({ eventId: event.id, name: '一号摊', loc: '图书馆前' });
  const item = repo.createItem({
    eventId: event.id, stallId: stall.id, name: '手作书签', totalQuota: 10,
  });
  const created = repo.createUser({ openid: `op-${Math.random()}`, name: '同学甲' });
  const user = created.user;

  return { db, repo, api, clock, event, stall, item, user, close: () => db.close() };
}

/** 预定一次；requestId 自动唯一，避免撞幂等 */
function reserve(ctx, user, extra = {}) {
  codeSeq += 1;
  return ctx.api.reserve({
    body: { itemId: ctx.item.id, requestId: `rq-${codeSeq}`, qty: 1, ...extra },
    user,
  });
}

const err = (r) => (r.body && r.body.error) || null;

/* ============================================================
   口令
   ============================================================ */

test('口令：没设口令的活动，预定不需要带 pass', () => {
  const ctx = fixture();
  try {
    const r = reserve(ctx, ctx.user);
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
  } finally { ctx.close(); }
});

test('口令：设了口令，不带 / 带错 / 带对 三种结果分得清', () => {
  const ctx = fixture({ passCode: '482913' });
  try {
    const none = reserve(ctx, ctx.user);
    assert.equal(none.status, 200);
    assert.equal(err(none), 'pass_required', '不带口令要说「需要口令」，不能直接说约满');

    const wrong = reserve(ctx, ctx.user, { pass: '000000' });
    assert.equal(err(wrong), 'pass_wrong');

    const right = reserve(ctx, ctx.user, { pass: '482913' });
    assert.equal(right.body.ok, true, JSON.stringify(right.body));
  } finally { ctx.close(); }
});

test('口令：错 5 次锁 1 小时，锁住期间连对的也不放行', () => {
  const ctx = fixture({ passCode: '482913' });
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal(err(reserve(ctx, ctx.user, { pass: '111111' })), 'pass_wrong', `第 ${i + 1} 次`);
    }

    const locked = reserve(ctx, ctx.user, { pass: '482913' });
    assert.equal(err(locked), 'pass_locked', '锁住之后即使口令对也不能过');
    assert.equal(locked.status, 429);

    // 时间往后走 1 小时，锁解除
    ctx.clock.t += 60 * 60 * 1000 + 1000;
    const after = reserve(ctx, ctx.user, { pass: '482913' });
    assert.equal(after.body.ok, true, '锁过期后应该能正常预定：' + JSON.stringify(after.body));
  } finally { ctx.close(); }
});

test('口令：改了口令，旧口令立刻失效', () => {
  const ctx = fixture({ passCode: '482913' });
  try {
    assert.equal(err(reserve(ctx, ctx.user, { pass: '482913' })), null);
    // 同一件物品再定会被判重复预定，所以换一件来试口令
    const another = ctx.repo.createItem({
      eventId: ctx.event.id, stallId: ctx.stall.id, name: '手作明信片', totalQuota: 2,
    });

    ctx.repo.setEventPassCode(ctx.event.id, '777777');
    const old = reserve({ ...ctx, item: another }, ctx.user, { pass: '482913' });
    assert.equal(err(old), 'pass_wrong', '旧口令必须失效');

    const fresh = reserve({ ...ctx, item: another }, ctx.user, { pass: '777777' });
    assert.equal(err(fresh), null, '新口令要能过：' + JSON.stringify(fresh.body));
  } finally { ctx.close(); }
});

test('口令：学生端接口不能泄露口令本身', () => {
  const ctx = fixture({ passCode: '482913' });
  try {
    const ev = ctx.api.getEvent().body.event;
    assert.equal(ev.passCode, undefined, 'GET /api/event 不能带口令');
    assert.equal(ev.passRequired, true, '但要告诉学生「需要口令」');

    const items = ctx.api.listItems().body.event;
    assert.equal(items.passCode, undefined, 'GET /api/items 同样不能带');
    assert.equal(items.passRequired, true);
  } finally { ctx.close(); }
});

/* ============================================================
   管理端口令
   ============================================================ */

test('管理端：只有一级管理员能改口令，6 位数字校验，能清空', () => {
  const ctx = fixture({ passCode: '482913' });
  try {
    const student = { ...ctx.user };
    const denied = ctx.api.adminSetEventPassCode({ body: { passCode: '111111' }, user: student });
    assert.equal(denied.status, 403);

    ctx.repo.setUserRole(ctx.user.id, 'admin');
    const senior = ctx.repo.findUserById(ctx.user.id);

    const bad = ctx.api.adminSetEventPassCode({ body: { passCode: '12345' }, user: senior });
    assert.equal(bad.status, 400, '5 位不是合法口令');

    const okr = ctx.api.adminSetEventPassCode({ body: { passCode: '123456' }, user: senior });
    assert.equal(okr.body.event.passCode, '123456');

    const cleared = ctx.api.adminSetEventPassCode({ body: { passCode: null }, user: senior });
    assert.equal(cleared.body.event.passCode, null, '清空 = 不启用');
  } finally { ctx.close(); }
});

/* ============================================================
   未取货降权
   ============================================================ */

test('降权：上一场预定了没取 → 本场最多约 1 件，且文案说清原因', () => {
  const ctx = fixture({ maxItemsPerUser: 10 });
  try {
    // 上一场：约了 2 件，然后活动结束，一件没取
    const first = reserve(ctx, ctx.user);
    assert.equal(first.body.ok, true);
    reserve(ctx, ctx.user);
    ctx.repo.updateEventStatus(ctx.event.id, 'ended');

    // 本场
    const next = ctx.repo.createEvent({ name: '秋季场', status: 'on_sale' });
    assert.ok(next.id);
    const stall2 = ctx.repo.createStall({ eventId: next.id, name: '二号摊' });
    const item2 = ctx.repo.createItem({
      eventId: next.id, stallId: stall2.id, name: '旧书', totalQuota: 10,
    });
    const ctx2 = { ...ctx, item: item2 };

    const one = reserve(ctx2, ctx.user);
    assert.equal(one.body.ok, true, '第一件应该能约：' + JSON.stringify(one.body));

    const two = reserve(ctx2, ctx.user);
    assert.equal(err(two), 'too_many', '第二件应该被降权挡住');
    assert.match(two.body.message, /上一场/, '文案要说清是被降权，而不是普通上限');
    assert.match(two.body.message, /1 件/);
  } finally { ctx.close(); }
});

test('降权：取消掉的不算失约', () => {
  const ctx = fixture();
  try {
    const r = reserve(ctx, ctx.user);
    assert.equal(ctx.repo.cancelReservation(r.body.reservation.id).ok, true, '取消要成功');
    ctx.repo.updateEventStatus(ctx.event.id, 'ended');

    const next = ctx.repo.createEvent({ name: '秋季场', status: 'on_sale' });
    const stall2 = ctx.repo.createStall({ eventId: next.id, name: '二号摊' });
    const item2 = ctx.repo.createItem({
      eventId: next.id, stallId: stall2.id, name: '旧书', totalQuota: 10,
    });
    const item3 = ctx.repo.createItem({
      eventId: next.id, stallId: stall2.id, name: '旧杂志', totalQuota: 10,
    });

    const a = reserve({ ...ctx, item: item2 }, ctx.user);
    const b = reserve({ ...ctx, item: item3 }, ctx.user);
    assert.equal(a.body.ok, true);
    assert.equal(b.body.ok, true, '取消过的人不该被降权：' + JSON.stringify(b.body));
  } finally { ctx.close(); }
});

test('降权：核销过的不算没取', () => {
  const ctx = fixture();
  try {
    const r = reserve(ctx, ctx.user);
    ctx.repo.setUserRole(ctx.user.id, 'volunteer');
    const vol = ctx.repo.findUserById(ctx.user.id);
    assert.equal(ctx.repo.redeem(ctx.event.id, r.body.reservation.code, vol.id).ok, true, '核销要成功');
    ctx.repo.updateEventStatus(ctx.event.id, 'ended');

    const next = ctx.repo.createEvent({ name: '秋季场', status: 'on_sale' });
    const stall2 = ctx.repo.createStall({ eventId: next.id, name: '二号摊' });
    const item2 = ctx.repo.createItem({
      eventId: next.id, stallId: stall2.id, name: '旧书', totalQuota: 10,
    });
    const item3 = ctx.repo.createItem({
      eventId: next.id, stallId: stall2.id, name: '旧杂志', totalQuota: 10,
    });

    const a = reserve({ ...ctx, item: item2 }, ctx.user);
    const b = reserve({ ...ctx, item: item3 }, ctx.user);
    assert.equal(a.body.ok, true);
    assert.equal(b.body.ok, true, '取过货的人不该被降权：' + JSON.stringify(b.body));
  } finally { ctx.close(); }
});

/* ============================================================
   客户端：口令输入栏确实接上了
   ============================================================ */

test('小程序：确认弹层里有口令输入，且走的是 pass 字段', () => {
  const wxml = read(path.join(MP, 'packageBazaar/pages/detail/index.wxml'));
  const js = read(path.join(MP, 'packageBazaar/pages/detail/index.js'));

  assert.match(wxml, /bindinput="onPassInput"/, '弹层里要有口令输入框');
  assert.match(wxml, /needPass/, '只有需要时才显示');
  assert.match(js, /onPassInput\(e\)/, '输入框要有人接');
  assert.match(js, /pass:\s*String\(this\.data\.pass/, '提交时要带上 pass');
  assert.match(js, /pass_wrong/, '服务端说不对时要清缓存重新输入');
  assert.match(js, /pass:.*eventId|pass:\$\{eventId\}/, '口令缓存要按活动分开存');
});

test('小程序：活动页能设 / 改口令', () => {
  const wxml = read(path.join(MP, 'packageAdmin/pages/event/index.wxml'));
  const js = read(path.join(MP, 'packageAdmin/pages/event/index.js'));

  assert.match(wxml, /bindtap="editPass"/, '活动卡片上要有改口令入口');
  assert.match(wxml, /bindinput="onPassCode"/, '建活动时能顺手设口令');
  assert.match(js, /\/api\/admin\/event\/pass/, '要调设置口令的接口');
  assert.match(js, /passCode/, '请求体里要带 passCode');
});
