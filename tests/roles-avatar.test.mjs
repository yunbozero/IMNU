/**
 * 用户头像 + 角色人数上限。
 *
 * 头像：学生自己传，角色管理页靠它认人（只显示头像 + 昵称）。
 * 上限：超管 1（靠「只能转交」保证）、一级管理员 3（硬）、副主任 5（软）、志愿者不限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import { createApi, ROLE_LIMITS } from '../server/api.mjs';
import { MAX_IMAGE_BASE64 } from '../server/images.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(p, 'utf8');

/** 一段最小的「合法 JPEG」：服务端只认魔术字节 */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0)]);
const B64 = JPEG.toString('base64');

function fixture() {
  const db = openMigrated(':memory:');
  const repo = createSqliteRepository(db);
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-'));

  const api = createApi({
    repo, secret: 'test-secret-0123456789abcdef', signToken: () => 'token',
    makeCode: () => '123456', imageDir,
  });

  const owner = repo.createUser({ openid: 'op-owner', name: '超管' }).user;
  repo.setUserRole(owner.id, 'admin');            // setUserRole 拒绝直接设 owner
  repo.bootstrapOwner(owner.id);
  const me = repo.findUserById(owner.id);

  const mkStudent = (n) => repo.createUser({ openid: `op-${n}`, name: `同学${n}` }).user;

  return {
    db, repo, api, imageDir, owner: me, mkStudent,
    reload: (id) => repo.findUserById(id),
    close: () => db.close(),
  };
}

/* ============================================================
   头像
   ============================================================ */

test('头像：学生能传自己的，服务端存图并把文件名写进账号', () => {
  const ctx = fixture();
  try {
    const stu = ctx.mkStudent('a');
    const r = ctx.api.setMyAvatar({ body: { image: B64 }, user: stu });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.ok(r.body.user.avatar, '返回的账号要带新头像');
    assert.match(r.body.user.avatar, /^img_[0-9a-f]{32}\.jpg$/);

    // 文件真的落盘了
    const files = fs.readdirSync(ctx.imageDir);
    assert.equal(files.length, 1);
    assert.equal(files[0], r.body.user.avatar);

    // 别人的账号不受影响
    const other = ctx.mkStudent('b');
    assert.equal(ctx.reload(other.id).avatar, null);
  } finally { ctx.close(); }
});

test('头像：传 null 就是清掉，界面回落到昵称首字', () => {
  const ctx = fixture();
  try {
    const stu = ctx.mkStudent('a');
    ctx.api.setMyAvatar({ body: { image: B64 }, user: stu });
    assert.ok(ctx.reload(stu.id).avatar);

    const cleared = ctx.api.setMyAvatar({ body: { image: null }, user: stu });
    assert.equal(cleared.body.ok, true);
    assert.equal(ctx.reload(stu.id).avatar, null);
  } finally { ctx.close(); }
});

test('头像：不是图片 / 太大 / 未登录都要拒', () => {
  const ctx = fixture();
  try {
    const stu = ctx.mkStudent('a');

    const notImage = ctx.api.setMyAvatar({ body: { image: Buffer.from('hello').toString('base64') }, user: stu });
    assert.equal(notImage.status, 400, '认不出魔术字节的不能存');

    const huge = ctx.api.setMyAvatar({ body: { image: 'A'.repeat(MAX_IMAGE_BASE64 + 10) }, user: stu });
    assert.equal(huge.status, 413, '解码前就按长度拦掉');

    const anon = ctx.api.setMyAvatar({ body: { image: B64 }, user: null });
    assert.equal(anon.status, 401);

    assert.equal(ctx.repo.listUsers().every((u) => !u.avatar), true, '失败时不能留下半套数据');
  } finally { ctx.close(); }
});

test('头像：/api/me 要能带出来（「我的」页靠它渲染）', () => {
  const ctx = fixture();
  try {
    const stu = ctx.mkStudent('a');
    ctx.api.setMyAvatar({ body: { image: B64 }, user: stu });

    const me = ctx.api.me({ user: ctx.reload(stu.id) });
    assert.ok(me.body.user.avatar, 'me 返回的 user 里要有 avatar');
  } finally { ctx.close(); }
});

/* ============================================================
   人数上限
   ============================================================ */

test('上限：一级管理员最多 3 人，第 4 个要被拒', () => {
  const ctx = fixture();
  try {
    const names = ['a', 'b', 'c', 'd'];
    const ids = names.map((n) => ctx.mkStudent(n).id);

    for (let i = 0; i < ROLE_LIMITS.admin; i++) {
      const r = ctx.api.adminSetRole({ body: { userId: ids[i], role: 'admin' }, user: ctx.owner });
      assert.equal(r.body.ok, true, `第 ${i + 1} 个应该成功：${JSON.stringify(r.body)}`);
    }

    const fourth = ctx.api.adminSetRole({ body: { userId: ids[3], role: 'admin' }, user: ctx.owner });
    assert.equal(fourth.body.ok, false);
    assert.equal(fourth.body.error, 'too_many_admins');
    assert.match(fourth.body.message, new RegExp(String(ROLE_LIMITS.admin)));
    assert.equal(ctx.reload(ids[3]).role, 'student', '被拒的那位角色不变');
  } finally { ctx.close(); }
});

test('上限：副主任是软上限，服务端不拦（只靠界面提醒）', () => {
  const ctx = fixture();
  try {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ctx.mkStudent(n).id);

    for (let i = 0; i < ROLE_LIMITS.deputy + 1; i++) {
      const r = ctx.api.adminSetRole({ body: { userId: ids[i], role: 'deputy' }, user: ctx.owner });
      assert.equal(r.body.ok, true, `第 ${i + 1} 个副主任应该放行：${JSON.stringify(r.body)}`);
    }

    const listed = ctx.api.adminListUsers({ user: ctx.owner });
    assert.equal(listed.body.counts.deputy, ROLE_LIMITS.deputy + 1, '人数照实返回，界面据此提示');
  } finally { ctx.close(); }
});

test('上限：名单接口要返回各级别人数和上限（界面靠它显示 2/3）', () => {
  const ctx = fixture();
  try {
    ctx.api.adminSetRole({ body: { userId: ctx.mkStudent('a').id, role: 'admin' }, user: ctx.owner });
    ctx.api.adminSetRole({ body: { userId: ctx.mkStudent('b').id, role: 'volunteer' }, user: ctx.owner });

    const r = ctx.api.adminListUsers({ user: ctx.owner });
    assert.deepEqual(r.body.limits, ROLE_LIMITS);
    assert.equal(r.body.counts.owner, 1);
    assert.equal(r.body.counts.admin, 1);
    assert.equal(r.body.counts.volunteer, 1);
    assert.ok(r.body.users.every((u) => 'avatar' in u), '每行都要带 avatar 字段（没传就是 null）');
  } finally { ctx.close(); }
});

test('上限：志愿者没有上限', () => {
  const ctx = fixture();
  try {
    for (let i = 0; i < 8; i++) {
      const r = ctx.api.adminSetRole({ body: { userId: ctx.mkStudent(`v${i}`).id, role: 'volunteer' }, user: ctx.owner });
      assert.equal(r.body.ok, true, `第 ${i + 1} 个志愿者应该放行`);
    }
    assert.equal(ctx.api.adminListUsers({ user: ctx.owner }).body.counts.volunteer, 8);
  } finally { ctx.close(); }
});

/* ============================================================
   界面接线
   ============================================================ */

test('界面：「我的」页能换头像，角色管理页显示头像 + 分块', () => {
  const profileWxml = read(path.join(MP, 'pages/profile/index.wxml'));
  assert.match(profileWxml, /bindtap="changeAvatar"/, '点头像要能换');
  assert.match(profileWxml, /bindtap="clearAvatar"/, '要能移除');

  const profileJs = read(path.join(MP, 'pages/profile/index.js'));
  assert.match(profileJs, /\/api\/me\/avatar/, '要走换头像的接口');

  const rolesWxml = read(path.join(MP, 'packageAdmin/pages/roles/index.wxml'));
  assert.match(rolesWxml, /wx:for="\{\{sections\}\}"/, '要按角色分块');
  assert.match(rolesWxml, /u__avatar/, '卡片上要有头像');
  assert.match(rolesWxml, /bindtap="openDetail"/, '点卡片看详情');

  const rolesJs = read(path.join(MP, 'packageAdmin/pages/roles/index.js'));
  assert.match(rolesJs, /counts/, '要用服务端返回的人数');
  assert.match(rolesJs, /limits/, '要用服务端返回的上限');
  assert.match(rolesJs, /还能再任命其他一级管理员/, '提 admin 时要写清后果');
});

/* ============================================================
   本届负责人（只读名单）
   ============================================================ */

test('名单：只返回负责人，不含普通学生', () => {
  const ctx = fixture();
  try {
    const stu = ctx.mkStudent('普通');
    ctx.api.adminSetRole({ body: { userId: ctx.mkStudent('副').id, role: 'deputy' }, user: ctx.owner });
    ctx.api.adminSetRole({ body: { userId: ctx.mkStudent('志').id, role: 'volunteer' }, user: ctx.owner });

    const r = ctx.api.listMembers({ user: stu });
    const roles = r.body.members.map((m) => m.role);
    assert.deepEqual(roles, ['owner', 'deputy', 'volunteer'], '按级别排，且没有 student');
    assert.equal(r.body.members.some((m) => m.name === '普通'), false, '普通学生不该出现在名单里');
  } finally { ctx.close(); }
});

test('名单：字段是白名单 —— 不带 openid / sid / 权限结构', () => {
  const ctx = fixture();
  try {
    const stu = ctx.mkStudent('a');
    const r = ctx.api.listMembers({ user: stu });
    const one = r.body.members[0];
    assert.deepEqual(Object.keys(one).sort(), ['avatar', 'name', 'role', 'roleLabel']);

    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes('openid'), '不能把 openid 发给普通用户');
    assert.ok(!raw.includes('settable'), '更不能把「谁能改谁」发给普通用户');
    assert.ok(!raw.includes('canTransferOwner'));
  } finally { ctx.close(); }
});

test('名单：没登录不能看；没有负责人时返回空数组', () => {
  const ctx = fixture();
  try {
    assert.equal(ctx.api.listMembers({ user: null }).status, 401);

    // 把唯一的超管也降成学生，名单就空了
    const stu = ctx.mkStudent('a');
    ctx.repo.setUserRole(ctx.owner.id, 'student');
    const r = ctx.api.listMembers({ user: stu });
    assert.deepEqual(r.body.members, []);
  } finally { ctx.close(); }
});

test('名单：页面注册了、入口在「我的」页、走的是 /api/members', () => {
  const app = JSON.parse(read(path.join(MP, 'app.json')));
  assert.ok(app.pages.includes('pages/members/index'), '页面要在主包注册（学生也要能进）');

  for (const f of ['index.js', 'index.wxml', 'index.wxss', 'index.json']) {
    assert.ok(fs.existsSync(path.join(MP, 'pages/members', f)), `缺 pages/members/${f}`);
  }

  const wxml = read(path.join(MP, 'pages/profile/index.wxml'));
  assert.match(wxml, /bindtap="goMembers"/, '「我的」页要有入口');

  const js = read(path.join(MP, 'pages/members/index.js'));
  assert.match(js, /\/api\/members/, '要读只读名单接口');
  assert.doesNotMatch(js, /settable|canTransferOwner|changeRole/, '这一页不能有任何改权限的动作');
});
