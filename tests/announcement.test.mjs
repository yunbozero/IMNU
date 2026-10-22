/**
 * 首页公告。
 *
 * 三种模式（和上一届项目 Verify 集合同一个口径）：
 *   0 不展示 / 1 强制展示（点「知道了」才关）/ 2 五秒自动关
 *
 * 公告存在 settings 表里一条 JSON —— 复用已有的键值表，不为它单开一张表。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import { createApi, ANNOUNCEMENT_TITLE_MAX } from '../server/api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(p, 'utf8');

function fixture(role = 'admin') {
  const db = openMigrated(':memory:');
  const repo = createSqliteRepository(db);
  const api = createApi({
    repo, secret: 'test-secret-0123456789abcdef', signToken: () => 'token', makeCode: () => '123456',
  });
  const user = repo.createUser({ openid: 'op-1', name: '管理员' }).user;
  repo.setUserRole(user.id, role);
  return { db, repo, api, user: repo.findUserById(user.id), close: () => db.close() };
}

test('公告：一开始没有公告', () => {
  const ctx = fixture();
  try {
    assert.equal(ctx.api.getAnnouncement().body.announcement, null);
  } finally { ctx.close(); }
});

test('公告：发布后公开接口能读到，撤下后变回 null', () => {
  const ctx = fixture();
  try {
    const set = ctx.api.adminSetAnnouncement({
      body: { mode: 1, title: '本周六开放预定', content: '图书馆前，9:00 开始' },
      user: ctx.user,
    });
    assert.equal(set.body.ok, true, JSON.stringify(set.body));

    const got = ctx.api.getAnnouncement().body.announcement;
    assert.equal(got.mode, 1);
    assert.equal(got.title, '本周六开放预定');
    assert.equal(got.content, '图书馆前，9:00 开始');
    assert.match(got.date, /^\d{4}-\d{2}-\d{2}$/, '要带日期，页面上显示它');

    const cleared = ctx.api.adminSetAnnouncement({ body: { mode: 0 }, user: ctx.user });
    assert.equal(cleared.body.announcement, null);
    assert.equal(ctx.api.getAnnouncement().body.announcement, null, '撤下后不能再读到');
  } finally { ctx.close(); }
});

test('公告：只有 0/1/2 三种模式，其它值要拒', () => {
  const ctx = fixture();
  try {
    for (const mode of [3, -1, 1.5, 'x']) {
      const r = ctx.api.adminSetAnnouncement({ body: { mode, title: '标题' }, user: ctx.user });
      assert.equal(r.status, 400, `mode=${mode} 应该被拒`);
    }
    assert.equal(ctx.api.adminSetAnnouncement({ body: { mode: 2, title: '标题' }, user: ctx.user }).body.ok, true);
  } finally { ctx.close(); }
});

test('公告：标题太长要拒（和界面 maxlength 对齐）', () => {
  const ctx = fixture();
  try {
    const r = ctx.api.adminSetAnnouncement({
      body: { mode: 1, title: '一'.repeat(ANNOUNCEMENT_TITLE_MAX + 1) },
      user: ctx.user,
    });
    assert.equal(r.status, 400);

    const ok = ctx.api.adminSetAnnouncement({
      body: { mode: 1, title: '一'.repeat(ANNOUNCEMENT_TITLE_MAX) },
      user: ctx.user,
    });
    assert.equal(ok.body.ok, true, '刚好到上限要放行');
  } finally { ctx.close(); }
});

test('公告：普通管理员改不了（要一级管理员及以上）', () => {
  const ctx = fixture('deputy');
  try {
    const r = ctx.api.adminSetAnnouncement({ body: { mode: 1, title: '标题' }, user: ctx.user });
    assert.equal(r.status, 403);
  } finally { ctx.close(); }
});

test('公告：界面接上了（首页横幅 + 管理端表单）', () => {
  const home = read(path.join(MP, 'pages/home/index.wxml'));
  assert.match(home, /announceVisible/, '首页要有公告位');
  assert.match(home, /bindtap="closeAnnouncement"/, '要能点「知道了」收起');

  const homeJs = read(path.join(MP, 'pages/home/index.js'));
  assert.match(homeJs, /\/api\/announcement/, '首页要拉公告');
  assert.match(homeJs, /mode === 2/, 'mode 2 要五秒后自动收');
  assert.match(homeJs, /clearTimeout\(this\._announceTimer\)/, '定时器要清 —— 页面走了不该再 setData');

  const admin = read(path.join(MP, 'packageAdmin/pages/event/index.wxml'));
  assert.match(admin, /bindtap="saveAnnouncement"/, '管理端要有保存公告的入口');
  assert.match(admin, /bindinput="onAnnTitle"/);
});
