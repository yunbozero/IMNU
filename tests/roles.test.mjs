/**
 * 角色权限策略的穷举测试。
 *
 * 这里刻意不"测几个典型场景"，而是**把整张表钉死**：
 * 每个 (操作者, 目标身份, 新身份) 组合都断一个明确结果。
 * 权限判断漏一个组合的后果是「有人能删掉不该删的人」，不是界面难看。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES, RANK, ROLE_LABEL,
  isRole, canRedeem, canManage,
  canGrant, canRevoke, canTransferOwner,
  checkRoleChange, checkOwnerTransfer, auditPolicy,
} from '../server/roles.mjs';

/* ============================================================
   策略自洽性：权限表本身不能自相矛盾
   ============================================================ */

test('权限：策略自检没有任何自相矛盾', () => {
  const problems = auditPolicy();
  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

test('权限：五个角色都有中文名，且层级不重复', () => {
  for (const r of ROLES) {
    assert.ok(ROLE_LABEL[r], `${r} 缺少中文名`);
    assert.equal(typeof RANK[r], 'number', `${r} 缺少层级`);
  }
  const ranks = ROLES.map((r) => RANK[r]);
  assert.equal(new Set(ranks).size, ranks.length, '层级值不能重复');
  assert.ok(RANK.owner > RANK.admin, '超管必须高于一级管理员');
  assert.ok(RANK.admin > RANK.deputy, '一级必须高于二级');
  assert.ok(RANK.deputy > RANK.volunteer, '二级必须高于志愿者');
  assert.ok(RANK.volunteer > RANK.student, '志愿者必须高于学生');
});

test('权限：isRole 只认这五个', () => {
  for (const r of ROLES) assert.equal(isRole(r), true);
  for (const bad of ['root', 'superadmin', 'Admin', '', null, undefined, 1, {}]) {
    assert.equal(isRole(bad), false, `${JSON.stringify(bad)} 不该被当成合法角色`);
  }
});

test('权限：核销与管理后台的门槛', () => {
  assert.equal(canRedeem('student'), false);
  assert.equal(canRedeem('volunteer'), true);
  assert.equal(canRedeem('deputy'), true);
  assert.equal(canRedeem('admin'), true);
  assert.equal(canRedeem('owner'), true);

  assert.equal(canManage('student'), false);
  assert.equal(canManage('volunteer'), false);
  assert.equal(canManage('deputy'), true);
  assert.equal(canManage('admin'), true);
  assert.equal(canManage('owner'), true);
});

/* ============================================================
   ★ 任命 / 撤销 真值表
   ============================================================ */

/** 讨论定下来的规则，逐格写死 */
const GRANT_TABLE = {
  //         目标:  admin  deputy volunteer
  owner:   { admin: true,  deputy: true,  volunteer: true },
  admin:   { admin: true,  deputy: true,  volunteer: true },
  deputy:  { admin: false, deputy: false, volunteer: true },
  volunteer: { admin: false, deputy: false, volunteer: false },
  student: { admin: false, deputy: false, volunteer: false },
};

const REVOKE_TABLE = {
  owner:   { admin: true,  deputy: true,  volunteer: true },
  admin:   { admin: false, deputy: true,  volunteer: true },   // ★ 一级不能撤销一级
  deputy:  { admin: false, deputy: false, volunteer: true },
  volunteer: { admin: false, deputy: false, volunteer: false },
  student: { admin: false, deputy: false, volunteer: false },
};

test('权限：任命真值表逐格对齐', () => {
  for (const actor of ROLES) {
    for (const target of ['admin', 'deputy', 'volunteer']) {
      const expected = GRANT_TABLE[actor][target];
      assert.equal(canGrant(actor, target), expected,
        `${ROLE_LABEL[actor]} 任命 ${ROLE_LABEL[target]} 应当是 ${expected}`);
    }
  }
});

test('权限：撤销真值表逐格对齐（含「一级不能撤销一级」）', () => {
  for (const actor of ROLES) {
    for (const target of ['admin', 'deputy', 'volunteer']) {
      const expected = REVOKE_TABLE[actor][target];
      assert.equal(canRevoke(actor, target), expected,
        `${ROLE_LABEL[actor]} 撤销 ${ROLE_LABEL[target]} 应当是 ${expected}`);
    }
  }
});

test('权限：没有任何角色能任命或撤销超管', () => {
  for (const actor of ROLES) {
    assert.equal(canGrant(actor, 'owner'), false, `${actor} 不该能任命超管`);
    assert.equal(canRevoke(actor, 'owner'), false, `${actor} 不该能撤销超管`);
  }
});

test('权限：一级管理员可以任命一级（换届要多人干活），但不能撤销一级', () => {
  assert.equal(canGrant('admin', 'admin'), true, '一级应当能任命一级');
  assert.equal(canRevoke('admin', 'admin'), false,
    '一级不能撤销一级 —— 这是防内斗互删，代价是只有超管能清理');
});

test('权限：二级管理员无权撤销管理员', () => {
  assert.equal(canRevoke('deputy', 'admin'), false);
  assert.equal(canRevoke('deputy', 'deputy'), false);
});

/* ============================================================
   ★ checkRoleChange 的完整判定
   ============================================================ */

const ACTOR = 'u_actor';
const TARGET = 'u_target';

test('权限：不能直接修改超管的身份', () => {
  const r = checkRoleChange({
    actorRole: 'owner', actorId: ACTOR, targetRole: 'owner', targetId: TARGET, nextRole: 'admin',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'owner_immutable');
  assert.match(r.message, /转交/);
});

test('权限：不能把人提升成超管（必须走转交流程）', () => {
  for (const actorRole of ROLES) {
    const r = checkRoleChange({
      actorRole, actorId: ACTOR, targetRole: 'volunteer', targetId: TARGET, nextRole: 'owner',
    });
    assert.equal(r.ok, false, `${actorRole} 不该能提升超管`);
    assert.equal(r.reason, 'use_transfer');
  }
});

test('权限：任何人都不能修改自己的身份（否则超管会把自己锁死）', () => {
  const r = checkRoleChange({
    actorRole: 'owner', actorId: ACTOR, targetRole: 'owner', targetId: ACTOR, nextRole: 'admin',
  });
  assert.equal(r.ok, false);
  // 先撞上"超管身份不可改"，这条更早。换一个非超管的目标再验自我修改。
  const r2 = checkRoleChange({
    actorRole: 'admin', actorId: ACTOR, targetRole: 'deputy', targetId: ACTOR, nextRole: 'volunteer',
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'self_change');
});

test('权限：合法操作要放行', () => {
  const cases = [
    { actorRole: 'owner', targetRole: 'volunteer', nextRole: 'admin' },
    { actorRole: 'admin', targetRole: 'volunteer', nextRole: 'deputy' },
    { actorRole: 'admin', targetRole: 'volunteer', nextRole: 'admin' },
    { actorRole: 'admin', targetRole: 'deputy', nextRole: 'volunteer' },   // 降级
    { actorRole: 'admin', targetRole: 'volunteer', nextRole: 'student' },  // 降为学生
    { actorRole: 'deputy', targetRole: 'volunteer', nextRole: 'student' },
    { actorRole: 'deputy', targetRole: 'student', nextRole: 'volunteer' },
  ];
  for (const c of cases) {
    const r = checkRoleChange({ ...c, actorId: ACTOR, targetId: TARGET });
    assert.equal(r.ok, true,
      `${ROLE_LABEL[c.actorRole]} 把 ${ROLE_LABEL[c.targetRole]} 改成 ${ROLE_LABEL[c.nextRole]} 应当允许，实际 ${JSON.stringify(r)}`);
  }
});

test('权限：非法操作要拒绝，且给出可读原因', () => {
  const cases = [
    { actorRole: 'deputy', targetRole: 'volunteer', nextRole: 'admin', expect: 'forbidden' },
    { actorRole: 'deputy', targetRole: 'deputy', nextRole: 'student', expect: 'forbidden' },
    { actorRole: 'volunteer', targetRole: 'student', nextRole: 'volunteer', expect: 'forbidden' },
    { actorRole: 'student', targetRole: 'volunteer', nextRole: 'student', expect: 'forbidden' },
    { actorRole: 'admin', targetRole: 'admin', nextRole: 'volunteer', expect: 'forbidden' },  // 一级撤一级
  ];
  for (const c of cases) {
    const r = checkRoleChange({ ...c, actorId: ACTOR, targetId: TARGET });
    assert.equal(r.ok, false,
      `${c.actorRole} → ${c.targetRole} 改成 ${c.nextRole} 应当被拒`);
    assert.equal(r.reason, c.expect);
    assert.ok(r.message && r.message.length > 0, '拒绝时必须给出人看得懂的原因');
  }
});

test('权限：入参不合法时拒绝，而不是放行', () => {
  const bad = [
    { actorRole: 'root', targetRole: 'volunteer', nextRole: 'student' },
    { actorRole: 'admin', targetRole: 'nobody', nextRole: 'student' },
    { actorRole: 'admin', targetRole: 'volunteer', nextRole: 'boss' },
    { actorRole: null, targetRole: 'volunteer', nextRole: 'student' },
  ];
  for (const c of bad) {
    const r = checkRoleChange({ ...c, actorId: ACTOR, targetId: TARGET });
    assert.equal(r.ok, false, `${JSON.stringify(c)} 应当被拒`);
  }
});

test('权限：穷举所有组合，不允许出现"意外放行"', () => {
  // 把 ROLES × ROLES × ROLES 全跑一遍，凡是 ok:true 的都必须能在合法清单里对上
  const allowed = new Set();
  for (const actor of ROLES) {
    for (const target of ROLES) {
      for (const next of ROLES) {
        if (target === 'owner' || next === 'owner') continue;
        const promote = RANK[next] > RANK[target];
        const ok = promote ? canGrant(actor, next) : canRevoke(actor, target);
        if (ok) allowed.add(`${actor}|${target}|${next}`);
      }
    }
  }

  const actuallyAllowed = [];
  for (const actor of ROLES) {
    for (const target of ROLES) {
      for (const next of ROLES) {
        const r = checkRoleChange({
          actorRole: actor, actorId: ACTOR, targetRole: target, targetId: TARGET, nextRole: next,
        });
        if (r.ok) actuallyAllowed.push(`${actor}|${target}|${next}`);
      }
    }
  }

  assert.deepEqual(actuallyAllowed.sort(), [...allowed].sort(),
    'checkRoleChange 放行的组合必须和权限表完全一致');
});

/* ============================================================
   转交超管
   ============================================================ */

test('权限：只有超管能转交超管', () => {
  assert.equal(canTransferOwner('owner'), true);
  for (const r of ['admin', 'deputy', 'volunteer', 'student']) {
    assert.equal(canTransferOwner(r), false);
    const res = checkOwnerTransfer({ actorRole: r, actorId: ACTOR, targetId: TARGET });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'forbidden');
  }
});

test('权限：不能转交给自己，也不能不选人', () => {
  const self = checkOwnerTransfer({ actorRole: 'owner', actorId: ACTOR, targetId: ACTOR });
  assert.equal(self.ok, false);
  assert.equal(self.reason, 'self_transfer');

  const empty = checkOwnerTransfer({ actorRole: 'owner', actorId: ACTOR, targetId: null });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'bad_target');
});

test('权限：超管转交出去是允许的', () => {
  const r = checkOwnerTransfer({ actorRole: 'owner', actorId: ACTOR, targetId: TARGET });
  assert.equal(r.ok, true);
});
