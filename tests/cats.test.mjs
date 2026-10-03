/**
 * 猫猫图鉴（B 方案：资料在数据库里）。
 *
 * 三块：
 *   1. **接口** —— 公开读、副主任及以上能写、字段校验、换图删旧文件；
 *   2. **services/cats.js 的行为** —— 缓存、失败返回 null、坏数据过滤；
 *      这是「断网也能看图鉴」这条承诺的唯一实现处，只读源码断言是不够的，
 *      所以用 platform 的假实现（见 services/platform.js）真跑一遍；
 *   3. **枚举漂移** —— 状态/性别两边各存一份，靠这里比对，别各自漂走。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/http.mjs';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import { createFakeSessionProvider } from '../server/auth.mjs';
import {
  CAT_NAME_MAX, CAT_STATUSES, CAT_GENDERS, ITEM_TINTS, ITEM_EMOJI_MAX,
} from '../server/api.mjs';
import { setPlatform, resetPlatform, originalPlatform } from '../miniprogram/services/platform.js';
import * as cats from '../miniprogram/services/cats.js';
import { CAT_STATUS, CAT_LIST_GROUPS } from '../miniprogram/data/cats.js';
import {
  STATUSES as MP_STATUSES, GENDERS as MP_GENDERS, buildCatBody,
  NAME_MAX as MP_NAME_MAX, EMOJI_MAX,
} from '../miniprogram/packageAdmin/utils/cat-form.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(p, 'utf8');

/* ============================================================
   1. 接口
   ============================================================ */

const SECRET = 'cats-test-secret-16cha';

const PEOPLE = {
  'code-student': { openid: 'op-s', name: '同学甲', role: 'student' },
  'code-volunteer': { openid: 'op-v', name: '志愿者', role: 'volunteer' },
  'code-deputy': { openid: 'op-d', name: '副主任', role: 'deputy' },
  'code-admin': { openid: 'op-a', name: '一级管理员', role: 'admin' },
  // 超管单独走 bootstrapOwner —— repo.setUserRole 拒绝直接设成 owner
  // （reason: use_transfer），这是刻意的：超管身份只能转交。
  'code-owner': { openid: 'op-o', name: '超管', role: 'owner' },
};

async function startTestServer({ cats: seed = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-cats-'));
  const dbPath = path.join(dir, 'bazaar.db');
  const imageDir = path.join(dir, 'images');
  fs.mkdirSync(imageDir, { recursive: true });

  const db = openMigrated(dbPath);
  const repo = createSqliteRepository(db);
  for (const p of Object.values(PEOPLE)) {
    p.id = repo.createUser({ openid: p.openid, name: p.name, role: 'student' }).user.id;
  }
  for (const p of Object.values(PEOPLE)) {
    if (p.role === 'owner') repo.bootstrapOwner(p.id);
    else if (p.role !== 'student') repo.setUserRole(p.id, p.role);
  }
  const seeded = seed.map((c) => repo.createCat(c).cat);
  db.close();

  const srv = await startServer({
    port: 0, dbPath, imageDir, secret: SECRET, log: () => {},
    sessions: createFakeSessionProvider(
      Object.fromEntries(Object.entries(PEOPLE).map(([code, p]) => [code, p.openid]))
    ),
  });

  const base = `http://127.0.0.1:${srv.port}`;
  const tokens = {};
  for (const code of Object.keys(PEOPLE)) {
    const res = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    tokens[code] = (await res.json()).token;
  }

  return {
    ...srv, dir, dbPath, imageDir, base, tokens, seeded,
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
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 静态文件不是 JSON */ }
  return { status: res.status, body: json, text };
}

const createCat = (ctx, token, body) =>
  call(ctx, 'POST', '/api/admin/cat/create', { token, body });
const updateCat = (ctx, token, body) =>
  call(ctx, 'POST', '/api/admin/cat', { token, body });
const deleteCat = (ctx, token, body) =>
  call(ctx, 'POST', '/api/admin/cat/delete', { token, body });

async function uploadImage(ctx, token, size = 64) {
  const buf = Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
    Buffer.alloc(Math.max(0, size - 4), 7),
  ]);
  const r = await call(ctx, 'POST', '/api/admin/image', {
    token, body: { image: buf.toString('base64') },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.image;
}

test('图鉴：没登录也能读（tabBar 一级页面，谁打开都要看到）', async () => {
  const ctx = await startTestServer({ cats: [{ name: '大橘', location: '图书馆前' }] });
  try {
    const r = await call(ctx, 'GET', '/api/cats');
    assert.equal(r.status, 200);
    assert.equal(r.body.cats.length, 1);
    assert.equal(r.body.cats[0].name, '大橘');
    assert.equal(r.body.cats[0].status, 'onCampus', '默认应当是在校');
    assert.equal(r.body.cats[0].location, '图书馆前');
  } finally { await ctx.close(); }
});

test('图鉴：学生不能改，志愿者及以上可以（照片要能在校园里随手传）', async () => {
  const ctx = await startTestServer();
  try {
    const anon = await createCat(ctx, undefined, { name: '大橘' });
    assert.equal(anon.status, 401);

    const stu = await createCat(ctx, ctx.tokens['code-student'], { name: '大橘' });
    assert.equal(stu.status, 403, '学生不该能加猫');
    assert.equal(stu.body.error, 'forbidden');

    // ★ 志愿者**可以**：图鉴的门槛刻意比物品低一档。
    //   照片是猫猫组的人在校园里拍的，他们不一定是副主任；
    //   而图鉴改错了没有名额那种后果（不占预定、不影响名单）。
    for (const who of ['code-volunteer', 'code-deputy']) {
      const r = await createCat(ctx, ctx.tokens[who], { name: '测试猫' });
      assert.equal(r.status, 200, `${who} 应当能加猫：${JSON.stringify(r.body)}`);
      assert.equal(r.body.cat.name, '测试猫');
    }
  } finally { await ctx.close(); }
});

test('图鉴：传图也是志愿者及以上（否则志愿者配不了照片）', async () => {
  // ★ 这条是「图鉴降到志愿者」的连带条件：照片走的是 /api/admin/image，
  //   那个接口如果还是副主任+，志愿者就只能填文字、配不了图 ——
  //   而配照片恰恰是这个功能存在的理由。
  //
  //   放宽是安全的：传上来的文件是**惰性的**，没人引用它就没有任何作用；
  //   挂到物品上仍然要副主任+，挂到猫上要志愿者+。
  const ctx = await startTestServer();
  try {
    const stu = await call(ctx, 'POST', '/api/admin/image', {
      token: ctx.tokens['code-student'],
      body: { image: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4]).toString('base64') },
    });
    assert.equal(stu.status, 403, '学生还是不能传');

    const vol = await uploadImage(ctx, ctx.tokens['code-volunteer']);
    assert.ok(vol, '志愿者要能传图');
  } finally { await ctx.close(); }
});

test('图鉴：物品那边的门槛没有被顺手带低（志愿者仍然不能改物品）', async () => {
  // 降档只针对图鉴。降一个共享接口的时候最容易连坐 —— 这条专门盯着它。
  const ctx = await startTestServer();
  try {
    const r = await call(ctx, 'POST', '/api/admin/item', {
      token: ctx.tokens['code-volunteer'], body: { itemId: 'it_x', quotaDelta: 1 },
    });
    assert.equal(r.status, 403, '志愿者不该能改物品名额');

    const del = await call(ctx, 'POST', '/api/admin/item/create', {
      token: ctx.tokens['code-volunteer'], body: { name: '东西', totalQuota: 1 },
    });
    assert.equal(del.status, 403, '志愿者不该能新建物品');
  } finally { await ctx.close(); }
});

test('图鉴：加猫时名字必填，各项字数卡住', async () => {
  const ctx = await startTestServer();
  try {
    const noName = await createCat(ctx, ctx.tokens['code-deputy'], { location: '图书馆' });
    assert.equal(noName.status, 400);
    assert.match(noName.body.message, /名字/);

    const longName = await createCat(ctx, ctx.tokens['code-deputy'],
      { name: '一'.repeat(CAT_NAME_MAX + 1) });
    assert.equal(longName.status, 400);

    // 边界：正好等于上限要放行（不要差一位就全拒了）
    const atLimit = await createCat(ctx, ctx.tokens['code-deputy'],
      { name: '一'.repeat(CAT_NAME_MAX) });
    assert.equal(atLimit.status, 200, JSON.stringify(atLimit.body));
  } finally { await ctx.close(); }
});

test('图鉴：状态 / 性别 / 底色 只认白名单里的值', async () => {
  const ctx = await startTestServer();
  try {
    for (const bad of ['在校园里', 'oncampus', '', 'UNKNOWN']) {
      const r = await createCat(ctx, ctx.tokens['code-deputy'], { name: '猫', status: bad });
      assert.equal(r.status, 400, `status=${JSON.stringify(bad)} 应当被拒`);
    }
    for (const bad of ['公猫', 'male', 'x']) {
      const r = await createCat(ctx, ctx.tokens['code-deputy'], { name: '猫', gender: bad });
      assert.equal(r.status, 400, `gender=${JSON.stringify(bad)} 应当被拒`);
    }
    const badTint = await createCat(ctx, ctx.tokens['code-deputy'], { name: '猫', tint: 't-red' });
    assert.equal(badTint.status, 400);
  } finally { await ctx.close(); }
});

test('图鉴：性别可以留空（新建时没填不该报错）', async () => {
  // gender 是可选字段：不传 ≠ 传了非法值。这两件事在实现里很容易混。
  const ctx = await startTestServer();
  try {
    const r = await createCat(ctx, ctx.tokens['code-deputy'], { name: '大橘' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.cat.gender, null);
  } finally { await ctx.close(); }
});

test('图鉴：改资料是「传什么改什么」，只改名字不会把别的字段清空', async () => {
  // ★ 这是局部更新最容易写错的地方：把没传的字段当 null 写回去，
  //   于是「只改名字」顺手把性格和地点都抹了。
  const ctx = await startTestServer({
    cats: [{ name: '大橘', location: '图书馆前', personality: '亲人', note: '已绝育' }],
  });
  const id = ctx.seeded[0].id;
  try {
    const r = await updateCat(ctx, ctx.tokens['code-deputy'], { catId: id, name: '橘座' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.cat.name, '橘座');
    assert.equal(r.body.cat.location, '图书馆前', '地点不该被清空');
    assert.equal(r.body.cat.personality, '亲人', '性格不该被清空');
    assert.equal(r.body.cat.note, '已绝育', '备注不该被清空');

    // 但显式传空串是「清掉」—— 要和「没传」区分开
    const cleared = await updateCat(ctx, ctx.tokens['code-deputy'], { catId: id, note: '' });
    assert.equal(cleared.body.cat.note, null, '传空串应当真的清掉');
    assert.equal(cleared.body.cat.personality, '亲人', '其它字段仍然不动');
  } finally { await ctx.close(); }
});

test('图鉴：改一只不存在的猫要 404，而不是静默成功', async () => {
  const ctx = await startTestServer();
  try {
    const r = await updateCat(ctx, ctx.tokens['code-deputy'], { catId: 'cat_nope', name: 'x' });
    assert.equal(r.status, 404);

    const noId = await updateCat(ctx, ctx.tokens['code-deputy'], { name: 'x' });
    assert.equal(noId.status, 400);
  } finally { await ctx.close(); }
});

test('图鉴：换照片会删掉旧的上传文件（不然每换一次留一张没人用的图）', async () => {
  const ctx = await startTestServer({ cats: [{ name: '大橘' }] });
  const id = ctx.seeded[0].id;
  try {
    const first = await uploadImage(ctx, ctx.tokens['code-deputy'], 200);
    await updateCat(ctx, ctx.tokens['code-deputy'], { catId: id, image: first });
    assert.equal(fs.existsSync(path.join(ctx.imageDir, first)), true);

    const second = await uploadImage(ctx, ctx.tokens['code-deputy'], 300);
    const r = await updateCat(ctx, ctx.tokens['code-deputy'], { catId: id, image: second });
    assert.equal(r.body.cat.image, second);

    assert.equal(fs.existsSync(path.join(ctx.imageDir, first)), false,
      '被换下来的旧图应当删掉');
    assert.equal(fs.existsSync(path.join(ctx.imageDir, second)), true,
      '新图不能跟着一起删');

    // 设成同一张时不该把文件删了
    await updateCat(ctx, ctx.tokens['code-deputy'], { catId: id, image: second });
    assert.equal(fs.existsSync(path.join(ctx.imageDir, second)), true,
      '设成同一张时不能把文件删掉');
  } finally { await ctx.close(); }
});

test('图鉴：照片文件名必须是服务端生成的那种，否则不收', async () => {
  const ctx = await startTestServer({ cats: [{ name: '大橘' }] });
  const id = ctx.seeded[0].id;
  try {
    for (const bad of ['daju.jpg', 'cats/daju.jpg', '../bazaar.db', 'img_zzzz.jpg', 'a/b.jpg']) {
      const r = await updateCat(ctx, ctx.tokens['code-deputy'], { catId: id, image: bad });
      assert.equal(r.status, 400, `image=${bad} 应当被拒`);
    }
  } finally { await ctx.close(); }
});

test('图鉴：删猫是真删，并清掉它的照片', async () => {
  const ctx = await startTestServer({ cats: [{ name: '大橘' }] });
  const id = ctx.seeded[0].id;
  try {
    const img = await uploadImage(ctx, ctx.tokens['code-deputy']);
    await updateCat(ctx, ctx.tokens['code-deputy'], { catId: id, image: img });

    const r = await deleteCat(ctx, ctx.tokens['code-deputy'], { catId: id });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const after = await call(ctx, 'GET', '/api/cats');
    assert.deepEqual(after.body.cats, [], '删掉之后公开接口里不该还有它');
    assert.equal(fs.existsSync(path.join(ctx.imageDir, img)), false, '照片文件也要清掉');

    const again = await deleteCat(ctx, ctx.tokens['code-deputy'], { catId: id });
    assert.equal(again.status, 404, '重复删除要说找不到，而不是静默成功');
  } finally { await ctx.close(); }
});

test('图鉴：增删改都要留审计日志（换届时唯一的凭据）', async () => {
  const ctx = await startTestServer();
  try {
    const made = await createCat(ctx, ctx.tokens['code-deputy'], { name: '大橘' });
    const id = made.body.cat.id;
    await updateCat(ctx, ctx.tokens['code-deputy'], { catId: id, name: '橘座' });
    await deleteCat(ctx, ctx.tokens['code-deputy'], { catId: id });

    const db = openMigrated(ctx.dbPath);
    try {
      const rows = db.prepare(
        "SELECT action, target_id FROM audit_logs WHERE target_type = 'cat' ORDER BY id"
      ).all();
      assert.deepEqual(rows.map((r) => r.action), ['cat.create', 'cat.update', 'cat.delete']);
      assert.deepEqual(rows.map((r) => r.target_id), [id, id, id]);
    } finally { db.close(); }
  } finally { await ctx.close(); }
});

test('图鉴：列表按录入顺序，不带分组', async () => {
  const ctx = await startTestServer({
    cats: [
      { name: '甲', status: 'missing' },
      { name: '乙', status: 'onCampus' },
      { name: '丙', status: 'passed' },
    ],
  });
  try {
    const r = await call(ctx, 'GET', '/api/cats');
    assert.deepEqual(r.body.cats.map((c) => c.name), ['甲', '乙', '丙'],
      '顺序就是录入顺序 —— 分组是界面的事，服务端不该插手');
  } finally { await ctx.close(); }
});

/* ============================================================
   ★ 人员名单与提权（角色管理页靠这个接口）
   ============================================================ */

/**
 * 提权/转交的测试环境。默认那套里就已经有一个超管（code-owner），
 * 所以这里不需要再提谁 —— 直接复用。
 */
const startRoleServer = () => startTestServer();

const listUsers = (ctx, token) => call(ctx, 'GET', '/api/admin/users', { token });

test('人员名单：副主任及以上能看，学生不能', async () => {
  const ctx = await startTestServer();
  try {
    assert.equal((await listUsers(ctx, undefined)).status, 401);
    assert.equal((await listUsers(ctx, ctx.tokens['code-student'])).status, 403);
    assert.equal((await listUsers(ctx, ctx.tokens['code-volunteer'])).status, 403);
    assert.equal((await listUsers(ctx, ctx.tokens['code-deputy'])).status, 200);
  } finally { await ctx.close(); }
});

test('人员名单：★ 不返回 openid（界面用 userId 就够，那是能定位到人的标识）', async () => {
  const ctx = await startTestServer();
  try {
    const r = await listUsers(ctx, ctx.tokens['code-deputy']);
    assert.ok(r.body.users.length >= 3);
    for (const u of r.body.users) {
      assert.equal(u.openid, undefined, `${u.name} 的 openid 不该出现在列表里`);
      assert.ok(u.id && u.name && u.role && u.roleLabel, '该有的字段要有');
    }
  } finally { await ctx.close(); }
});

test('人员名单：★ 逐行算好「能改成哪些角色」，界面不用自己判断', async () => {
  // 这是这一页最要紧的设计：权限规则只有 roles.mjs 一处，
  // 界面拿到的就是「能点的按钮」。
  const ctx = await startRoleServer();
  const me = ctx.tokens['code-owner'];
  try {
    const r = await listUsers(ctx, me);
    const by = (name) => r.body.users.find((u) => u.name === name);

    // 超管自己那一行：一个按钮都没有
    const self = by('超管');
    assert.equal(self.role, 'owner');
    assert.equal(self.isSelf, true);
    assert.deepEqual(self.settable, [],
      '★ 不能改自己的身份 —— 否则一次误点就把自己降级，系统从此没有超管');
    assert.equal(self.canTransferOwner, false, '也不能把超管转交给自己');

    // 一级管理员那一行：超管能改他，也能把身份交给他
    const admin = by('一级管理员');
    assert.equal(admin.canTransferOwner, true, '超管可以把身份转交给别人');
    assert.ok(admin.settable.includes('deputy'), '超管能任命二级管理员');
    assert.ok(admin.settable.includes('volunteer'));
    assert.ok(admin.settable.includes('student'), '也要能撤销回学生');
    assert.ok(!admin.settable.includes('admin'),
      '他已经是一级了，「设为一级」是空操作，不该出现在按钮里');
    assert.ok(!admin.settable.includes('owner'),
      '★ 超管身份只能走「转交」，不能出现在普通改角色的按钮里');
  } finally { await ctx.close(); }
});

test('人员名单：副主任那一档的按钮很窄（只能任命志愿者）', async () => {
  // 服务端的 adminSetRole 门槛是副主任+，但真值表只给了他任命志愿者一项。
  // 界面按 settable 画，所以副主任打开这一页几乎都是「你没有权限改这个人」。
  const ctx = await startRoleServer();
  try {
    const r = await listUsers(ctx, ctx.tokens['code-deputy']);
    const by = (name) => r.body.users.find((u) => u.name === name);

    assert.deepEqual(by('同学甲').settable, ['volunteer'],
      '副主任只能把学生提成志愿者 —— 别的都不该给他按钮');

    assert.deepEqual(by('一级管理员').settable, [], '副主任动不了一级管理员');
    assert.equal(by('一级管理员').canTransferOwner, false, '更不可能转交超管');
    assert.deepEqual(by('超管').settable, [], '也动不了超管');

    // 页面的门槛是一级管理员，所以这一档主要是服务端的保证 ——
    // 但 settable 已经在界面上把它们画成「没有按钮」，不会误导人
  } finally { await ctx.close(); }
});

test('提权走接口：改完立刻生效，并留审计日志', async () => {
  const ctx = await startRoleServer();
  try {
    const before = await listUsers(ctx, ctx.tokens['code-owner']);
    const stu = before.body.users.find((u) => u.name === '同学甲');

    const r = await call(ctx, 'POST', '/api/admin/role', {
      token: ctx.tokens['code-owner'], body: { userId: stu.id, role: 'volunteer' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.to, 'volunteer');

    const after = await listUsers(ctx, ctx.tokens['code-owner']);
    assert.equal(after.body.users.find((u) => u.id === stu.id).role, 'volunteer');

    const db = openMigrated(ctx.dbPath);
    try {
      const rows = db.prepare(
        "SELECT action, target_id FROM audit_logs WHERE action = 'role.change'"
      ).all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].target_id, stu.id);
    } finally { db.close(); }
  } finally { await ctx.close(); }
});

test('转交超管：换过去之后原来那个变成一级管理员，而且只剩一个超管', async () => {
  const ctx = await startRoleServer();
  const me = ctx.tokens['code-owner'];
  try {
    const list = await listUsers(ctx, me);
    const admin = list.body.users.find((u) => u.name === '一级管理员');

    const r = await call(ctx, 'POST', '/api/admin/transfer-owner', {
      token: me, body: { userId: admin.id },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.to.role, 'owner');
    assert.equal(r.body.from.role, 'admin', '★ 自己会降成一级管理员');

    const db = openMigrated(ctx.dbPath);
    try {
      const owners = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'owner'").get().c;
      assert.equal(owners, 1, '任何时刻都必须正好有一个超管');
    } finally { db.close(); }
  } finally { await ctx.close(); }
});

test('转交超管：不是超管就拒绝（一级管理员之间不能互相清洗）', async () => {
  const ctx = await startRoleServer();
  try {
    const list = await listUsers(ctx, ctx.tokens['code-owner']);
    const stu = list.body.users.find((u) => u.name === '同学甲');

    for (const who of ['code-admin', 'code-deputy', 'code-student']) {
      const r = await call(ctx, 'POST', '/api/admin/transfer-owner', {
        token: ctx.tokens[who], body: { userId: stu.id },
      });
      assert.equal(r.status, 403, `${who} 不该能转交超管：${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, 'forbidden');
    }
  } finally { await ctx.close(); }
});

test('提权：一级管理员可以任命一级，但撤不掉另一个一级', async () => {
  // roles.mjs 的真值表：GRANT.admin 含 admin（换届要多人干活），
  // REVOKE.admin 不含 admin（多个一级之间不能互相清洗）。
  const ctx = await startRoleServer();
  try {
    const list = await listUsers(ctx, ctx.tokens['code-owner']);
    const stu = list.body.users.find((u) => u.name === '同学甲');

    // 超管把学生提成一级 —— 现在有两个人是一级
    const up = await call(ctx, 'POST', '/api/admin/role', {
      token: ctx.tokens['code-owner'], body: { userId: stu.id, role: 'admin' },
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));

    // 一级管理员自己撤不掉另一个一级
    const down = await call(ctx, 'POST', '/api/admin/role', {
      token: ctx.tokens['code-admin'], body: { userId: stu.id, role: 'deputy' },
    });
    assert.equal(down.status, 403, JSON.stringify(down.body));
    assert.match(down.body.message, /不能撤销/);

    // 也任命不了别人当一级？—— 可以，这是明确允许的（换届要多人干活）
    const other = list.body.users.find((u) => u.name === '志愿者');
    const up2 = await call(ctx, 'POST', '/api/admin/role', {
      token: ctx.tokens['code-admin'], body: { userId: other.id, role: 'admin' },
    });
    assert.equal(up2.status, 200, '一级管理员应当能任命一级：' + JSON.stringify(up2.body));
  } finally { await ctx.close(); }
});

test('提权：名单里的 settable 和真正调接口的结果一致', async () => {
  // ★ 这条防的是「界面显示能点、点了被拒」：按钮来自 settable，
  //   而 settable 又是拿 checkRoleChange 算的 —— 两边必须是同一个判定。
  //
  //   每次尝试前**重新拉一次名单**：这条测试自己会改角色，
  //   拿一开始那份快照去比就会读到过期的 settable（第一版就是这么错的）。
  const ctx = await startRoleServer();
  const me = ctx.tokens['code-owner'];
  try {
    const first = await listUsers(ctx, me);
    const names = first.body.users.map((u) => u.name);
    let checked = 0;

    for (const name of names) {
      const snapshot = await listUsers(ctx, me);
      const u = snapshot.body.users.find((x) => x.name === name);

      for (const role of ['student', 'volunteer', 'deputy', 'admin']) {
        const r = await call(ctx, 'POST', '/api/admin/role', {
          token: me, body: { userId: u.id, role },
        });

        if (role === u.role) {
          // ★ 「设成同一个角色」这一格不进比较，原因值得写下来：
          //   checkRoleChange 里「没变」走的是**撤销**分支（按当前角色查 REVOKE 表），
          //   于是它的结果取决于谁在操作谁 —— 超管把学生设成学生是 403
          //   （REVOKE.owner 里没有 student），而超管把一级设成一级是 200。
          //   也就是说这一格本来就不统一。
          //
          //   但它**不可达**：settable 明确排除了当前角色，界面不会发出这种请求。
          //   所以这里只断言「按钮不该出现」，不对接口的行为下结论 ——
          //   为了一个界面永不发出的请求去改权限核心（roles.mjs）不划算。
          assert.ok(!u.settable.includes(role),
            `${u.name} 已经是 ${role}，不该给他「设为${role}」的按钮`);
        } else {
          const shouldPass = u.settable.includes(role);
          // ★ 要比的是 body.ok，不是 HTTP 状态码：本仓库的约定是
          //   「业务规则不允许 → 200 + ok:false + 能看懂的中文」，
          //   只有「在编造请求」（reason === 'forbidden'）才给 403。
          //   拿状态码比会漏掉一半的拒绝（超管改成学生就是 200 + ok:false）。
          assert.equal(r.body.ok === true, shouldPass,
            `${u.name}（${u.role}）改成 ${role}：`
            + `settable 里${shouldPass ? '有' : '没有'}，接口却返回 ok=${r.body.ok}`
            + `（${r.status} ${r.body.message || ''}）`);
        }
        checked += 1;

        // 改成功了就还原，免得影响后面那些组合
        if (r.body.ok === true && u.role !== role) {
          const back = await call(ctx, 'POST', '/api/admin/role', {
            token: me, body: { userId: u.id, role: u.role },
          });
          assert.equal(back.body.ok, true, `还原回 ${u.role} 失败：${JSON.stringify(back.body)}`);
        }
      }
    }
    assert.ok(checked >= 16, `组合太少（${checked}），这条测试就没守住什么`);
  } finally { await ctx.close(); }
});

test('角色管理：换届的三条路必须条条通（这是踩过的坑）', () => {
  // 这个坑值得单独钉一条：曾经三处文案都写着「换届走小程序里的转交超管」，
  // 而那个界面**根本不存在**，同时
  //   · set-role.mjs 的 ASSIGNABLE 排除了 owner，
  //   · set-owner.mjs 在已有超管时直接 exit 1。
  // 三条路全堵死 → 现任超管一毕业，系统永远卡在他身上。
  //
  // 现在 checkOwnerTransfer 这条接口早就有了，缺的一直是界面。
  // 所以这里确认三件事都在，缺任何一件都要红。
  const roleScript = read(path.join(ROOT, 'scripts', 'set-role.mjs'));
  const ownerScript = read(path.join(ROOT, 'scripts', 'set-owner.mjs'));

  // ① 界面里的转交入口（角色管理页）
  const page = read(path.join(MP, 'packageAdmin', 'pages', 'roles', 'index.js'));
  assert.match(page, /\/api\/admin\/transfer-owner/, '角色管理页要有转交超管的调用');
  assert.match(page, /\/api\/admin\/role/, '也要能改角色');

  // ② 两个脚本的提示不能再指向不存在的界面
  for (const [name, src] of [['set-role.mjs', roleScript], ['set-owner.mjs', ownerScript]]) {
    if (!/转交超管/.test(src)) continue;
    assert.match(src, /管理端 · 角色管理/,
      `${name} 提到了「转交超管」，就要把界面路径写全（我的 → 管理端 · 角色管理）`);
  }

  // ③ set-role 仍然不能设超管（这是刻意的：超管只能转交）
  assert.match(roleScript, /ROLES\.filter\(\(r\) => r !== 'owner'\)/,
    'set-role 必须继续排除 owner');

  // 而服务端接口这一路是通的
  assert.match(read(path.join(ROOT, 'server', 'http.mjs')), /api\/admin\/transfer-owner/);
});

test('角色管理：改完之后对方要重新进「我的」页才看得到新入口', () => {
  // 角色是在进入那一页时才读的，停在旧页面上不会自己刷 ——
  // 「给他开了权限他说没有」就是这么来的。界面上要写清楚。
  const wxml = read(path.join(MP, 'packageAdmin', 'pages', 'roles', 'index.wxml'));
  assert.match(wxml, /重新进一次「我的」页/, '要说清改完什么时候生效');
});

/* ============================================================
   2. services/cats.js 的行为
   ============================================================ */

/** 把 platform 换成可控的假实现。★ 必须 await（finally 要在 fn 跑完之后才还原）。 */
async function withFakePlatform(patch, fn) {
  const store = new Map();
  setPlatform({
    request: async () => { throw new Error('这个用例不该发请求'); },
    getStorage: (k) => (store.has(k) ? store.get(k) : null),
    setStorage: (k, v) => { store.set(k, v); },
    removeStorage: (k) => { store.delete(k); },
    ...patch,
  });
  try {
    return await fn(store);
  } finally {
    resetPlatform(originalPlatform);
  }
}

const okWith = (list) => async () => ({ statusCode: 200, data: { ok: true, cats: list } });

const A_CAT = {
  id: 'cat_1', name: '大橘', emoji: '🐱', tint: 't-orange', image: null,
  status: 'onCampus', gender: '公', location: '图书馆前', personality: '亲人', note: '',
};

test('图鉴：拉成功要写缓存，decorate 补上照片地址和状态文案', async () => {
  await withFakePlatform({ request: okWith([A_CAT]) }, async (store) => {
    const list = await cats.fetchCats();
    assert.equal(list.length, 1);
    assert.deepEqual(store.get(cats.STORAGE_KEY), list, '成功的结果要存下来');

    const d = cats.decorate(list[0]);
    assert.equal(d.photo, '', '没有照片时是空串（界面据此回落 emoji）');
    assert.equal(d.statusText, '在校');
  });
});

test('图鉴：有照片时 decorate 拼出完整地址', async () => {
  const d = cats.decorate({ ...A_CAT, image: 'img_aa.jpg' });
  assert.match(d.photo, /^https?:\/\/.+\/images\/img_aa\.jpg$/);
});

test('图鉴：★ 拉失败要返回 null，而且绝不能碰缓存', async () => {
  // 最要命的一条：失败时如果返回 [] 并写进缓存，一次断网就会把图鉴从本地清空，
  // 界面上表现为「猫全没了」，而服务端其实好好的。
  for (const fail of [
    async () => { throw new Error('断网'); },
    async () => ({ statusCode: 500, data: { ok: false, error: 'internal', message: '炸了' } }),
    async () => ({ statusCode: 200, data: null }),
  ]) {
    await withFakePlatform({ request: fail }, async (store) => {
      const before = [A_CAT];
      store.set(cats.STORAGE_KEY, before);

      const got = await cats.fetchCats();

      assert.equal(got, null, '失败必须是 null —— 好和「服务端说一只猫都没有」区分开');
      assert.deepEqual(store.get(cats.STORAGE_KEY), before, '失败时缓存必须原封不动');
      assert.deepEqual(cats.cached(), before);
    });
  }
});

test('图鉴：服务端说「一只猫都没有」是成功结果，缓存要跟着变空', async () => {
  await withFakePlatform({ request: okWith([]) }, async (store) => {
    store.set(cats.STORAGE_KEY, [A_CAT]);
    const got = await cats.fetchCats();
    assert.deepEqual(got, []);
    assert.deepEqual(store.get(cats.STORAGE_KEY), [],
      '管理员把猫都删了，缓存也要跟着清 —— 不然界面一直显示已经删掉的猫');
  });
});

test('图鉴：缓存坏掉时当成「没有缓存」，而且丢掉坏行而不是整份丢掉', async () => {
  await withFakePlatform({}, (store) => {
    // 整份不是数组 / 是垃圾
    for (const junk of ['一个字符串', 123, null, { cats: [] }]) {
      store.set(cats.STORAGE_KEY, junk);
      assert.deepEqual(cats.cached(), [], `缓存是 ${JSON.stringify(junk)} 时应当是空`);
    }

    // ★ 一条坏数据不该让整张图鉴消失 —— 好的那几条要留下来
    store.set(cats.STORAGE_KEY, [
      A_CAT,
      null,
      { name: '没有 id' },
      { id: 'cat_2' },                 // 没有 name
      { id: 'cat_3', name: '三花', status: 'onCampus' },
    ]);
    const got = cats.cached();
    assert.deepEqual(got.map((c) => c.id), ['cat_1', 'cat_3']);
    assert.equal(got[1].emoji, '', '缺的字段补成空串，别留 undefined');
  });
});

test('图鉴：byStatus 只按 status 过滤，不认识的猫不混进任何一栏', async () => {
  const list = [
    { ...A_CAT, id: 'a', status: 'onCampus' },
    { ...A_CAT, id: 'b', status: 'missing' },
    { ...A_CAT, id: 'c', status: 'passed' },
    { ...A_CAT, id: 'd', status: '别的状态' },
  ];
  assert.deepEqual(cats.byStatus(list, 'onCampus').map((c) => c.id), ['a']);
  assert.deepEqual(cats.byStatus(list, 'missing').map((c) => c.id), ['b']);
  assert.deepEqual(cats.byStatus(list, 'passed').map((c) => c.id), ['c']);

  // 每个分组键都要能对上服务端存的值，否则那一栏永远空着
  for (const g of CAT_LIST_GROUPS) {
    assert.ok(CAT_STATUSES.includes(g.key), `分组 ${g.key} 服务端不认识`);
  }
});

test('图鉴：findById 找不到要返回 null（详情页靠它判断「已被删掉」）', () => {
  assert.equal(cats.findById([A_CAT], 'cat_1').name, '大橘');
  assert.equal(cats.findById([A_CAT], 'cat_2'), null);
  assert.equal(cats.findById(null, 'cat_1'), null);
  assert.equal(cats.findById([], 'cat_1'), null);
});

/* ============================================================
   3. 枚举漂移：两边各存一份，靠这里比对
   ============================================================ */

test('图鉴：状态枚举两边必须一致（键在服务端，文案在小程序）', () => {
  const serverKeys = [...CAT_STATUSES].sort();
  const statusKeys = Object.keys(CAT_STATUS).sort();
  const groupKeys = CAT_LIST_GROUPS.map((g) => g.key).sort();
  const formKeys = MP_STATUSES.map((s) => s.key).sort();

  assert.deepEqual(statusKeys, serverKeys,
    'miniprogram/data/cats.js 的 CAT_STATUS 键和服务端 CAT_STATUSES 对不上 —— '
    + '缺失的键在界面上会显示成空白标签');
  assert.deepEqual(groupKeys, serverKeys,
    'CAT_LIST_GROUPS 少了一栏的话，那个状态的猫在任何分组里都看不到');
  assert.deepEqual(formKeys, serverKeys,
    '管理端表单的状态选项对不上 —— 改状态时会白挨一次 400');
});

test('图鉴：性别枚举两边必须一致', () => {
  assert.deepEqual([...MP_GENDERS].sort(), [...CAT_GENDERS].sort());
});

test('图鉴：字数上限两边必须一致（界面宽了会一路填到提交才被拒）', () => {
  assert.equal(MP_NAME_MAX, CAT_NAME_MAX);
  // 上限只在该被服务端卡住的地方出现，这里确认它们是正整数
  for (const n of [CAT_NAME_MAX, ITEM_TINTS.length, ITEM_EMOJI_MAX]) {
    assert.ok(Number.isInteger(n) && n > 0);
  }
});

test('图鉴：表单校验能拦住每一条服务端也会拒的输入', () => {
  const good = buildCatBody({
    name: '大橘', emoji: '🐱', tint: 't-orange', statusIndex: 0,
    gender: '公', location: '图书馆前', personality: '亲人', note: '',
  });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.deepEqual(good.body, {
    name: '大橘', emoji: '🐱', tint: 't-orange', image: null,
    status: 'onCampus', gender: '公',
    location: '图书馆前', personality: '亲人', note: '',
  });

  assert.equal(buildCatBody({ name: '   ' }).ok, false, '全空格的名字要拦');
  assert.equal(buildCatBody({ name: '一'.repeat(MP_NAME_MAX + 1) }).ok, false);
  assert.equal(buildCatBody({ name: '猫', location: '一'.repeat(31) }).ok, false);
  assert.equal(buildCatBody({ name: '猫', personality: '一'.repeat(61) }).ok, false);
  assert.equal(buildCatBody({ name: '猫', note: '一'.repeat(61) }).ok, false);

  // 按**码点数**算，不是按 length —— '🐱'.length 是 2，用 length 的话
  // 一个 emoji 就把 2 个位置全占了。上限本身和物品共用 ITEM_EMOJI_MAX。
  assert.equal(EMOJI_MAX, ITEM_EMOJI_MAX, '图标上限必须和物品那边一致');
  assert.equal(buildCatBody({ name: '猫', emoji: '🐱' }).ok, true);
  assert.equal(buildCatBody({ name: '猫', emoji: '🐱🐱' }).ok, true,
    '两个码点以内都算 —— 服务端也是这么卡的');
  assert.equal(buildCatBody({ name: '猫', emoji: '🐱🐱🐱' }).ok, false);
  assert.equal(buildCatBody({ name: '猫', emoji: '橘猫' }).ok, true, '两个字也行');

  // 认不出来的值回落到合法值，而不是把非法值发给服务端白挨一次 400
  assert.equal(buildCatBody({ name: '猫', tint: 't-red' }).body.tint, ITEM_TINTS[0]);
  assert.equal(buildCatBody({ name: '猫', gender: 'male' }).body.gender, '未知');
  assert.equal(buildCatBody({ name: '猫', statusIndex: 99 }).body.status, CAT_STATUSES[0]);
});

test('图鉴：管理端页面齐全，门槛是志愿者（收在 session.js 里）', () => {
  for (const rel of ['packageAdmin/pages/cats/index', 'packageAdmin/pages/cat-edit/index']) {
    for (const ext of ['.js', '.wxml', '.wxss', '.json']) {
      assert.ok(fs.existsSync(path.join(MP, rel + ext)), `${rel}${ext} 不存在`);
    }
    const js = read(path.join(MP, rel + '.js'));
    assert.match(js, /session\.isStaff\(\)/,
      `${rel} 的门槛要是志愿者及以上（isStaff），而且收在 session.js 里`);
    assert.doesNotMatch(js, /session\.isManager\(\)/, `${rel} 不该还留着副主任那一档`);
  }

  // 别的手写角色名不在这一页出现（由 miniprogram.test.mjs 全量守着）

  // 两页都要在 app.json 里登记，否则 wx.navigateTo 直接失败
  const app = JSON.parse(read(path.join(MP, 'app.json')));
  const admin = app.subPackages.find((p) => p.root === 'packageAdmin');
  for (const p of ['pages/cats/index', 'pages/cat-edit/index']) {
    assert.ok(admin.pages.includes(p), `app.json 里没登记 ${p}`);
  }
});

test('图鉴：小程序里已经没有任何地方还在读静态的 CATS 数组', () => {
  // 搬进数据库之后，如果还有页面读 data/cats.js 里的旧数组，
  // 那就是两份会各自过期的数据 —— 而且**不会报错**，只是内容对不上。
  const walk = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else if (e.name.endsWith('.js')) out.push(full);
    }
    return out;
  };

  const problems = [];
  for (const file of walk(MP)) {
    const rel = path.relative(MP, file).replace(/\\/g, '/');
    const src = read(file);
    // 只抓「从 data/cats.js 里取 CATS / findCat / catsByStatus」这种旧用法
    if (rel !== 'services/cats.js' && /\bCATS\b/.test(src)) {
      problems.push(`${rel} 里还在用 CATS`);
    }
    if (/from '[^']*data\/cats\.js'/.test(src)
        && /findCat|catsByStatus/.test(src)) {
      problems.push(`${rel} 里还在用 findCat / catsByStatus`);
    }
  }
  assert.deepEqual(problems, [],
    '这些地方还在读已经搬走的静态数组：\n' + problems.join('\n'));
});

test('图鉴：data/cats.js 只剩界面文案，没有猫的资料', async () => {
  const mod = await import('../miniprogram/data/cats.js');
  assert.deepEqual(Object.keys(mod).sort(),
    ['CAT_LIST_GROUPS', 'CAT_STATUS', 'FEEDING_TIPS'],
    'data/cats.js 应当只剩文案和分组；猫的资料在服务端');
});
