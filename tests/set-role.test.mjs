/**
 * scripts/set-role.mjs —— 给线上账号提权。
 *
 * 为什么它必须存在：小程序里**没有任命角色的界面**（接口早就有，界面一直没做），
 * 而 set-owner.mjs 只在「一个超管都没有」时生效一次。于是义卖当天最要紧的
 * 那件事 —— 给几个志愿者开核销权限 —— 在线上没有任何入口。
 *
 * 这里重点测两件容易出事的事：
 *   · **不许把现任超管降级**。从接口走有 roles.mjs 的策略挡着，而脚本是直接调
 *     数据层的，那道策略不经过；真降了系统会变成「零个超管」，
 *     接口再也转交不了。
 *   · **不许在这里设超管**。超管只能由 set-owner 产生一次，之后走「转交超管」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import { ROLES, ROLE_LABEL } from '../server/roles.mjs';
import { parseArgs, setRole, run, ASSIGNABLE } from '../scripts/set-role.mjs';

function makeRepo() {
  const db = openMigrated(':memory:');
  return { db, repo: createSqliteRepository(db) };
}

/** 造一个已登记的账号，返回它 */
function person(repo, { openid, name, role = 'student' }) {
  const r = repo.createUser({ openid, name, role }).user;
  return r;
}

/* ============================================================
   参数
   ============================================================ */

test('set-role：参数解析', () => {
  assert.deepEqual(parseArgs([]), { list: false, openid: '', role: '', help: false });
  assert.deepEqual(parseArgs(['--list']), { list: true, openid: '', role: '', help: false });
  assert.deepEqual(parseArgs(['op_1', 'deputy']),
    { list: false, openid: 'op_1', role: 'deputy', help: false });

  assert.throws(() => parseArgs(['--乱写']), /不认识的参数/);
  assert.throws(() => parseArgs(['a', 'b', 'c']), /多余的参数/);
});

test('set-role：能设的角色里没有超管', () => {
  assert.ok(!ASSIGNABLE.includes('owner'), '超管不能从这条路产生');
  assert.deepEqual([...ASSIGNABLE].sort(), [...ROLES].filter((r) => r !== 'owner').sort(),
    '能设的角色应当是全部角色减去超管 —— 角色表改了这里要跟着改');
});

/* ============================================================
   改角色
   ============================================================ */

test('set-role：能把学生提成志愿者 / 二级管理员 / 一级管理员', () => {
  for (const role of ASSIGNABLE.filter((r) => r !== 'student')) {
    const { db, repo } = makeRepo();
    try {
      person(repo, { openid: 'op_1', name: '同学甲' });
      const r = setRole(repo, { openid: 'op_1', role });

      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.from, 'student');
      assert.equal(r.to, role);
      assert.equal(repo.findUserByOpenid('op_1').role, role, '要真的落库');
    } finally { db.close(); }
  }
});

test('set-role：★ 不许在这里设超管', () => {
  const { db, repo } = makeRepo();
  try {
    person(repo, { openid: 'op_1', name: '同学甲' });
    const r = setRole(repo, { openid: 'op_1', role: 'owner' });

    assert.equal(r.ok, false);
    assert.equal(r.reason, 'use_owner_script');
    assert.match(r.message, /set-owner/, '要告诉他走哪条路');
    assert.match(r.message, /转交超管/, '换届的路也要说');
    assert.equal(repo.findUserByOpenid('op_1').role, 'student', '拒绝时不能有副作用');
    assert.equal(repo.countOwners(), 0);
  } finally { db.close(); }
});

test('set-role：★ 不许把现任超管降级（降了就再也没人能转交了）', () => {
  const { db, repo } = makeRepo();
  try {
    const u = person(repo, { openid: 'op_owner', name: '超管' });
    repo.bootstrapOwner(u.id);
    assert.equal(repo.countOwners(), 1);

    for (const role of ASSIGNABLE) {
      const r = setRole(repo, { openid: 'op_owner', role });
      assert.equal(r.ok, false, `不该能把他改成 ${role}`);
      assert.equal(r.reason, 'owner_immutable');
      assert.match(r.message, /转交超管/);
    }

    assert.equal(repo.countOwners(), 1, '超管必须还是一个');
    assert.equal(repo.findUserByOpenid('op_owner').role, 'owner');
  } finally { db.close(); }
});

test('set-role：角色名写错 / 找不到人，都要说清楚', () => {
  const { db, repo } = makeRepo();
  try {
    person(repo, { openid: 'op_1', name: '同学甲' });

    const bad = setRole(repo, { openid: 'op_1', role: '管理员' });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'bad_role');
    assert.match(bad.message, /student \/ volunteer/, '要把合法的角色名列出来');

    const missing = setRole(repo, { openid: '不存在', role: 'volunteer' });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'not_found');
    // ★ 这句提示很关键：开发者工具里的假 openid 和手机上的真实 openid 不是一回事
    assert.match(missing.message, /开发者工具/,
      '找不到人时要提醒「手机上的账号和开发者工具里那个不是同一个」');

    assert.equal(setRole(repo, { role: 'volunteer' }).ok, false, '没给 openid 也要拒');
  } finally { db.close(); }
});

test('set-role：改了角色要留操作日志', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-setrole-'));
  const dbPath = path.join(dir, 'b.db');
  try {
    const db = openMigrated(dbPath);
    const repo = createSqliteRepository(db);
    const u = person(repo, { openid: 'op_1', name: '志愿者甲' });
    db.close();

    const lines = [];
    assert.equal(run({
      argv: ['op_1', 'volunteer'],
      env: { DB_PATH: dbPath },
      out: (s) => lines.push(s),
      err: (s) => lines.push(`[err] ${s}`),
    }), 0);

    assert.match(lines.join('\n'), /volunteer/, '要把结果打出来');
    // 光改了角色不够：他手机上得**重新进一次「我的」页**才会看到新入口
    assert.match(lines.join('\n'), /「我的」/, '要提醒他重进「我的」页');

    const db2 = openMigrated(dbPath);
    try {
      const row = db2.prepare(
        "SELECT * FROM audit_logs WHERE action = 'role.change' ORDER BY id DESC LIMIT 1"
      ).get();
      assert.ok(row, '改角色要留日志 —— 换届纠纷时这是唯一的凭据');
      assert.equal(row.target_id, u.id);
      const detail = JSON.parse(row.detail);
      assert.equal(detail.from, 'student');
      assert.equal(detail.to, 'volunteer');
      assert.equal(detail.via, 'scripts/set-role.mjs');
    } finally { db2.close(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('set-role：--list 要打出 openid（脚本全靠它选人）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-setrole-'));
  const dbPath = path.join(dir, 'b.db');
  try {
    const db = openMigrated(dbPath);
    try {
      const repo = createSqliteRepository(db);
      person(repo, { openid: 'op_alpha', name: '甲' });
      person(repo, { openid: 'op_beta', name: '乙', role: 'volunteer' });
    } finally { db.close(); }

    const lines = [];
    assert.equal(run({ argv: ['--list'], env: { DB_PATH: dbPath }, out: (s) => lines.push(s) }), 0);
    const text = lines.join('\n');

    assert.match(text, /op_alpha/, '每个人的 openid 都要打出来，不然没法选人');
    assert.match(text, /op_beta/);
    assert.match(text, /volunteer/);
    // 中文角色名也要打出来，不然一堆英文名认不出谁是谁
    assert.match(text, new RegExp(ROLE_LABEL.volunteer));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('set-role：用法 / 空库都不能崩', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-setrole-'));
  const dbPath = path.join(dir, 'b.db');
  try {
    const lines = [];
    const errs = [];

    // 空库 + --list：要说「还没人登记」，而不是打一个空表让人以为坏了
    assert.equal(run({ argv: ['--list'], env: { DB_PATH: dbPath }, out: (s) => lines.push(s) }), 0);
    assert.match(lines.join('\n'), /还没有任何已登记的账号/);

    // 不带参数 = 列一遍 + 打用法
    lines.length = 0;
    assert.equal(run({ argv: [], env: { DB_PATH: dbPath }, out: (s) => lines.push(s) }), 0);
    assert.match(lines.join('\n'), /用法/);

    // 给了 openid 但没给角色
    lines.length = 0;
    assert.equal(run({
      argv: ['op_x'], env: { DB_PATH: dbPath },
      out: (s) => lines.push(s), err: (s) => errs.push(s),
    }), 1);
    assert.match(errs.join('\n'), /什么角色/);

    // --help
    lines.length = 0;
    assert.equal(run({ argv: ['--help'], out: (s) => lines.push(s) }), 0);
    assert.match(lines.join('\n'), /用法/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
