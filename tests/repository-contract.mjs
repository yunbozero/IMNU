/**
 * Repository 契约测试。
 *
 * ★ 这份文件是「一年后能安全迁到云开发」的保证书。
 *
 * 它不关心底层是 SQLite、MySQL 还是云数据库，只断言业务语义。
 * 将来写好云开发版实现，只要：
 *
 *     import { describeRepositoryContract } from './repository-contract.mjs';
 *     describeRepositoryContract('云开发', () => ({ repo: createCloudRepository(...) }));
 *
 * 全部通过，就说明迁移没有走样。不需要重新想一遍测试用例。
 *
 * 用法：describeRepositoryContract(label, makeRepo)
 *   makeRepo() 每次调用都要返回全新的、互相隔离的实现
 *   返回 { repo, cleanup? }
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { REPOSITORY_METHODS, generateCode } from '../server/repository.mjs';

export function describeRepositoryContract(label, makeRepo) {
  const t = (name, fn) => test(`[${label}] ${name}`, fn);

  /** 建好一个场次 + 一个摊位 + 一件给定名额的物品 */
  function fixture(repo, { quota = 10, qty = 1 } = {}) {
    const ev = repo.createEvent({ name: '测试场次', status: 'on_sale' });
    const stall = repo.createStall({ eventId: ev.id, name: '一号摊位', loc: '图书馆前' });
    const item = repo.createItem({
      eventId: ev.id, stallId: stall.id, name: '手作黄油曲奇',
      totalQuota: quota,
    });
    return { ev, stall, item, qty };
  }

  function person(repo, n) {
    return repo.createUser({
      openid: `openid-${n}`, sid: `2021000${n}`, name: `同学${n}`,
    }).user;
  }

  let seq = 0;
  const code = () => generateCode(new Set(), 9).slice(-6) + String(seq++ % 10);

  /* ============================================================
     接口完整性
     ============================================================ */

  t('实现了契约要求的全部方法', () => {
    const { repo, cleanup } = makeRepo();
    try {
      for (const m of REPOSITORY_METHODS) {
        assert.equal(typeof repo[m], 'function', `缺少方法 ${m}()`);
      }
    } finally { cleanup && cleanup(); }
  });

  /* ============================================================
     身份
     ============================================================ */

  t('同一个 openid 不能登记两次（防多开小号）', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const a = repo.createUser({ openid: 'o1', sid: '20210001', name: '甲' });
      assert.equal(a.ok, true);
      const b = repo.createUser({ openid: 'o1', sid: '20210002', name: '乙' });
      assert.equal(b.ok, false);
      assert.equal(b.reason, 'openid_taken');
    } finally { cleanup && cleanup(); }
  });

  t('同一个学号不能被两个微信号占用', () => {
    const { repo, cleanup } = makeRepo();
    try {
      repo.createUser({ openid: 'o1', sid: '20210001', name: '甲' });
      const b = repo.createUser({ openid: 'o2', sid: '20210001', name: '乙' });
      assert.equal(b.ok, false);
      assert.equal(b.reason, 'sid_taken');
    } finally { cleanup && cleanup(); }
  });

  t('没有学号的账号（志愿者）可以有多个', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const a = repo.createUser({ openid: 'v1', sid: null, name: '志愿者甲', role: 'volunteer' });
      const b = repo.createUser({ openid: 'v2', sid: null, name: '志愿者乙', role: 'volunteer' });
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
    } finally { cleanup && cleanup(); }
  });

  /* ============================================================
     预定：防超卖
     ============================================================ */

  t('预定成功会扣减名额', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 10 });
      const u = person(repo, 1);

      const r = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1,
        requestId: 'req-1', code: code(),
      });

      assert.equal(r.ok, true);
      assert.equal(r.reservation.status, 'reserved');
      assert.equal(repo.getItem(item.id).remainingQuota, 9);
      assert.equal(r.remaining, 9);
    } finally { cleanup && cleanup(); }
  });

  t('约满后预定失败，且名额不会被扣成负数', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 1 });

      const first = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: person(repo, 1).id, qty: 1,
        requestId: 'a', code: code(),
      });
      assert.equal(first.ok, true);

      const second = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: person(repo, 2).id, qty: 1,
        requestId: 'b', code: code(),
      });
      assert.equal(second.ok, false);
      assert.equal(second.reason, 'soldout');
      assert.equal(repo.getItem(item.id).remainingQuota, 0, '名额不能变成负数');
    } finally { cleanup && cleanup(); }
  });

  t('数量大于剩余名额时整体失败，不做部分扣减', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 3 });
      const r = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: person(repo, 1).id, qty: 4,
        requestId: 'x', code: code(),
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'soldout');
      assert.equal(repo.getItem(item.id).remainingQuota, 3, '失败时必须原样不动');
    } finally { cleanup && cleanup(); }
  });

  t('数量大于 1 时按数量扣减', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 5 });
      const r = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: person(repo, 1).id, qty: 2,
        requestId: 'multi', code: code(),
      });
      assert.equal(r.ok, true);
      assert.equal(r.reservation.qty, 2);
      assert.equal(repo.getItem(item.id).remainingQuota, 3);
    } finally { cleanup && cleanup(); }
  });

  t('同一件物品每人只能有一笔待取货预定，且失败时名额要还回去', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 5 });
      const u = person(repo, 1);

      repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1,
        requestId: 'r1', code: code(),
      });
      const dup = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1,
        requestId: 'r2', code: code(),
      });

      assert.equal(dup.ok, false);
      assert.equal(dup.reason, 'dup');
      // ★ 这一条很关键：重复预定失败时，上面那次数名额扣减必须被回滚
      assert.equal(repo.getItem(item.id).remainingQuota, 4, 'dup 失败不能白扣一个名额');
    } finally { cleanup && cleanup(); }
  });

  t('同一个 requestId 重复提交是幂等的，不会产生第二单', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 5 });
      const u = person(repo, 1);
      const c = code();

      const a = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 'same', code: c,
      });
      const b = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 'same', code: c,
      });

      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      assert.equal(b.idempotent, true, '第二次应当被识别为幂等重放');
      assert.equal(a.reservation.id, b.reservation.id, '必须返回同一笔预定');
      assert.equal(repo.getItem(item.id).remainingQuota, 4, '幂等重放只能扣一次名额');
    } finally { cleanup && cleanup(); }
  });

  t('已下架的物品不能预定', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const ev = repo.createEvent({ name: 'x', status: 'on_sale' });
      const item = repo.createItem({
        eventId: ev.id, name: '下架的物品', totalQuota: 5, status: 'off_shelf',
      });
      const r = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: person(repo, 1).id, qty: 1,
        requestId: 'off', code: code(),
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'off_shelf');
      assert.equal(repo.getItem(item.id).remainingQuota, 5, '下架物品的名额不能被动');
    } finally { cleanup && cleanup(); }
  });

  t('不存在的物品返回 not_found', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev } = fixture(repo);
      const r = repo.tryReserve({
        eventId: ev.id, itemId: '不存在的id', userId: person(repo, 1).id, qty: 1,
        requestId: 'nf', code: code(),
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'not_found');
    } finally { cleanup && cleanup(); }
  });

  /* ============================================================
     取消：名额必须精确释放
     ============================================================ */

  t('取消预定会把名额还回去', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 5 });
      const u = person(repo, 1);
      const r = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 2, requestId: 'c1', code: code(),
      });
      assert.equal(repo.getItem(item.id).remainingQuota, 3);

      const c = repo.cancelReservation(r.reservation.id);
      assert.equal(c.ok, true);
      assert.equal(c.released, 2);
      assert.equal(repo.getItem(item.id).remainingQuota, 5);
      assert.equal(repo.getReservation(r.reservation.id).status, 'cancelled');
    } finally { cleanup && cleanup(); }
  });

  t('重复取消必须失败，否则名额会虚增', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 5 });
      const u = person(repo, 1);
      const r = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 'c2', code: code(),
      });

      assert.equal(repo.cancelReservation(r.reservation.id).ok, true);
      const again = repo.cancelReservation(r.reservation.id);
      assert.equal(again.ok, false);
      assert.equal(repo.getItem(item.id).remainingQuota, 5, '第二次取消不能再加名额');
    } finally { cleanup && cleanup(); }
  });

  t('取消之后可以重新预定同一件物品', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 2 });
      const u = person(repo, 1);

      const first = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 're1', code: code(),
      });
      repo.cancelReservation(first.reservation.id);

      const second = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 're2', code: code(),
      });
      assert.equal(second.ok, true, '取消后应当能重新预定');
      assert.notEqual(second.reservation.id, first.reservation.id);
      assert.equal(repo.getItem(item.id).remainingQuota, 1);
    } finally { cleanup && cleanup(); }
  });

  /* ============================================================
     核销：单向状态转换
     ============================================================ */

  t('核销成功后状态变为已取货', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 3 });
      const u = person(repo, 1);
      const staff = repo.createUser({ openid: 's1', sid: null, name: '志愿者', role: 'volunteer' }).user;
      const c = code();

      const r = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 'rd1', code: c,
      });

      const ok = repo.redeem(ev.id, c, staff.id);
      assert.equal(ok.ok, true);
      assert.equal(ok.reservation.status, 'redeemed');
      assert.equal(ok.reservation.operatorId, staff.id);
      assert.ok(ok.reservation.redeemedAt, '必须记录核销时间');

      // 核销不退还名额——东西已经被领走了
      assert.equal(repo.getItem(item.id).remainingQuota, 2);
      void r;
    } finally { cleanup && cleanup(); }
  });

  t('同一个码第二次核销失败，且不覆盖首次的操作人', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 3 });
      const u = person(repo, 1);
      const a = repo.createUser({ openid: 'sa', sid: null, name: '志愿者A', role: 'volunteer' }).user;
      const b = repo.createUser({ openid: 'sb', sid: null, name: '志愿者B', role: 'volunteer' }).user;
      const c = code();

      repo.tryReserve({ eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 'rd2', code: c });
      assert.equal(repo.redeem(ev.id, c, a.id).ok, true);

      const second = repo.redeem(ev.id, c, b.id);
      assert.equal(second.ok, false);
      assert.equal(second.reason, 'redeemed');
      assert.equal(second.reservation.operatorId, a.id, '不能被第二个人的操作覆盖');
    } finally { cleanup && cleanup(); }
  });

  t('无效的取货码返回 invalid', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev } = fixture(repo);
      const r = repo.redeem(ev.id, '000000', null);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'invalid');
    } finally { cleanup && cleanup(); }
  });

  t('已取消的预定不能核销', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 3 });
      const u = person(repo, 1);
      const c = code();
      const r = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 'rd3', code: c,
      });
      repo.cancelReservation(r.reservation.id);

      const res = repo.redeem(ev.id, c, null);
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'cancelled');
    } finally { cleanup && cleanup(); }
  });

  t('取货码在同一个场次内唯一，且撞码是独立原因、不能白扣名额', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 5 });
      const c = code();
      repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: person(repo, 1).id, qty: 1, requestId: 'u1', code: c,
      });

      // 换个人、换个物品，用同一个码
      const other = repo.createItem({ eventId: ev.id, name: '别的物品', totalQuota: 5 });
      const clash = repo.tryReserve({
        eventId: ev.id, itemId: other.id, userId: person(repo, 2).id, qty: 1,
        requestId: 'u2', code: c,
      });

      assert.equal(clash.ok, false);
      // ★ 这里必须和「同一人重复预定」区分开。混成一个原因的话，
      //   取货码撞车时学生看到的是"你已经预定过这件物品了"，完全对不上。
      assert.equal(clash.reason, 'code_taken', '撞码应当是独立的失败原因，不能混成 dup');
      assert.equal(repo.getItem(other.id).remainingQuota, 5, '撞码失败时名额必须回滚');
    } finally { cleanup && cleanup(); }
  });

  /* ============================================================
     查询与审计
     ============================================================ */

  t('按人查询预定记录', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 9 });
      const u = person(repo, 1);
      const other = repo.createItem({ eventId: ev.id, name: '另一件', totalQuota: 9 });

      repo.tryReserve({ eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 'l1', code: code() });
      repo.tryReserve({ eventId: ev.id, itemId: other.id, userId: u.id, qty: 1, requestId: 'l2', code: code() });

      const mine = repo.listUserReservations(ev.id, u.id);
      assert.equal(mine.length, 2);
      assert.equal(repo.listUserReservations(ev.id, person(repo, 2).id).length, 0);
    } finally { cleanup && cleanup(); }
  });

  t('可以按取货码反查预定', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 9 });
      const u = person(repo, 1);
      const c = code();
      const r = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 'f1', code: c,
      });
      assert.equal(repo.findByCode(ev.id, c).id, r.reservation.id);
      assert.equal(repo.findByCode(ev.id, '999999'), null);
    } finally { cleanup && cleanup(); }
  });

  /* ============================================================
     管理端：改物品 / 撤销核销 / 角色 / 转交
     ============================================================ */

  t('管理：增减名额会同步调整总数与剩余', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { item } = fixture(repo, { quota: 10 });

      const add = repo.updateItem({ itemId: item.id, quotaDelta: 5 });
      assert.equal(add.ok, true);
      assert.equal(repo.getItem(item.id).totalQuota, 15);
      assert.equal(repo.getItem(item.id).remainingQuota, 15);

      const cut = repo.updateItem({ itemId: item.id, quotaDelta: -4 });
      assert.equal(cut.ok, true);
      assert.equal(repo.getItem(item.id).totalQuota, 11);
      assert.equal(repo.getItem(item.id).remainingQuota, 11);
    } finally { cleanup && cleanup(); }
  });

  t('管理：名额不能降到已锁定数量以下', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 10 });
      const u = person(repo, 1);
      repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 3, requestId: 'x', code: code(),
      });

      const r = repo.updateItem({ itemId: item.id, quotaDelta: -8 });   // 10 → 2，但已锁定 3
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'quota_below_locked');
      assert.equal(repo.getItem(item.id).totalQuota, 10, '失败时不能改动');
    } finally { cleanup && cleanup(); }
  });

  t('管理：上下架切换，且不动名额', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { item } = fixture(repo, { quota: 4 });

      assert.equal(repo.updateItem({ itemId: item.id, status: 'off_shelf' }).ok, true);
      assert.equal(repo.getItem(item.id).status, 'off_shelf');
      assert.equal(repo.getItem(item.id).remainingQuota, 4);

      assert.equal(repo.updateItem({ itemId: item.id, status: 'on_sale' }).ok, true);
      assert.equal(repo.getItem(item.id).status, 'on_sale');

      assert.throws(() => repo.updateItem({ itemId: item.id, status: '乱的' }), /未知的物品状态/);
    } finally { cleanup && cleanup(); }
  });

  t('管理：撤销核销把状态改回待取货，且不动名额', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 3 });
      const u = person(repo, 1);
      const c = code();
      const r = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 'u', code: c,
      });

      repo.redeem(ev.id, c, 'vol-1');
      assert.equal(repo.getItem(item.id).remainingQuota, 2);

      const undo = repo.undoRedeem(r.reservation.id, 'admin-1');
      assert.equal(undo.ok, true);
      assert.equal(undo.reservation.status, 'reserved');
      assert.equal(undo.reservation.redeemedAt, null, '核销时间要清掉');
      assert.equal(undo.reservation.operatorId, null, '经手人也要清掉');
      assert.equal(repo.getItem(item.id).remainingQuota, 2, '撤销核销不该动名额');
    } finally { cleanup && cleanup(); }
  });

  t('管理：只能撤销真正被核销过的，且不能撤销两次', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 3 });
      const u = person(repo, 1);
      const f = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 'u', code: code(),
      });

      const early = repo.undoRedeem(f.reservation.id, 'admin');
      assert.equal(early.ok, false);
      assert.equal(early.reason, 'not_redeemed');

      repo.redeem(ev.id, f.reservation.code, 'vol');
      assert.equal(repo.undoRedeem(f.reservation.id, 'admin').ok, true);
      assert.equal(repo.undoRedeem(f.reservation.id, 'admin').ok, false);
    } finally { cleanup && cleanup(); }
  });

  t('管理：撤销核销之后，这个人依然不能再预定同一件（active_key 是连贯的）', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 5 });
      const u = person(repo, 1);
      const f = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 'a', code: code(),
      });

      repo.redeem(ev.id, f.reservation.code, 'vol');
      const afterRedeem = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 'b', code: code(),
      });
      assert.equal(afterRedeem.ok, false, '已核销的不能再预定同一件');
      assert.equal(afterRedeem.reason, 'dup');

      repo.undoRedeem(f.reservation.id, 'admin');
      const afterUndo = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1, requestId: 'c', code: code(),
      });
      assert.equal(afterUndo.ok, false, '撤销核销后仍然不能重复预定');
      assert.equal(repo.getItem(item.id).remainingQuota, 4, '这些失败都不该白扣名额');
    } finally { cleanup && cleanup(); }
  });

  t('管理：直接设置角色，但不允许直接设成超管', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const u = person(repo, 1);
      const r = repo.setUserRole(u.id, 'deputy');
      assert.equal(r.ok, true);
      assert.equal(r.from, 'student');
      assert.equal(r.to, 'deputy');
      assert.equal(repo.findUserById(u.id).role, 'deputy');

      const bad = repo.setUserRole(u.id, 'owner');
      assert.equal(bad.ok, false);
      assert.equal(bad.reason, 'use_transfer', '超管只能通过转交产生');
    } finally { cleanup && cleanup(); }
  });

  t('管理：第一个超管只能从零到一设立，有了之后再也设不了', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const a = person(repo, 1);
      const b = person(repo, 2);

      assert.equal(repo.countOwners(), 0);
      assert.equal(repo.bootstrapOwner(a.id).ok, true);
      assert.equal(repo.countOwners(), 1);

      // 已经有超管了，再来一次必须被拒 —— 否则这个方法就是个抢权限的后门
      const again = repo.bootstrapOwner(b.id);
      assert.equal(again.ok, false);
      assert.equal(again.reason, 'already_has_owner');
      assert.equal(repo.countOwners(), 1, '任何时候都不能出现两个超管');
    } finally { cleanup && cleanup(); }
  });

  t('管理：转交超管后，超管有且只有一个', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const a = person(repo, 1);
      const b = person(repo, 2);
      repo.bootstrapOwner(a.id);
      assert.equal(repo.countOwners(), 1);

      const t1 = repo.transferOwnership({ fromUserId: a.id, toUserId: b.id });
      assert.equal(t1.ok, true);
      assert.equal(repo.countOwners(), 1, '转交之后仍然只能有一个超管');
      assert.equal(repo.findUserById(b.id).role, 'owner');
      assert.equal(repo.findUserById(a.id).role, 'admin', '原超管降为一级管理员，方便带一段时间');
    } finally { cleanup && cleanup(); }
  });

  t('管理：非超管不能转交，也不能转交给自己', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const a = person(repo, 1);
      const b = person(repo, 2);

      const r1 = repo.transferOwnership({ fromUserId: a.id, toUserId: b.id });
      assert.equal(r1.ok, false);
      assert.equal(r1.reason, 'not_owner');

      repo.bootstrapOwner(a.id);
      const r2 = repo.transferOwnership({ fromUserId: a.id, toUserId: a.id });
      assert.equal(r2.ok, false);
      assert.equal(r2.reason, 'self_transfer');
    } finally { cleanup && cleanup(); }
  });

  t('管理：能拉出全场次名单（导出纸质兜底名单要用）', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const { ev, item } = fixture(repo, { quota: 6 });
      const a = person(repo, 1);
      const b = person(repo, 2);

      const r1 = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: a.id, qty: 1, requestId: 'a', code: code(),
      });
      repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: b.id, qty: 2, requestId: 'b', code: code(),
      });
      repo.cancelReservation(r1.reservation.id);

      const all = repo.listEventReservations(ev.id);
      assert.equal(all.length, 2);
      assert.equal(all[0].itemName, '手作黄油曲奇', '名单要带物品名，不然打印出来看不懂');
      assert.ok(all[0].userName, '名单要带取货人姓名');
      assert.ok(all[0].userSid, '名单要带学号');

      assert.equal(repo.listEventReservations(ev.id, { status: 'reserved' }).length, 1);
    } finally { cleanup && cleanup(); }
  });

  t('可以写审计日志', () => {
    const { repo, cleanup } = makeRepo();
    try {
      assert.doesNotThrow(() => {
        repo.writeAudit({
          actorId: 'u_1', action: 'role.grant',
          targetType: 'user', targetId: 'u_2',
          detail: { from: 'student', to: 'admin' },
        });
      });
    } finally { cleanup && cleanup(); }
  });
}
