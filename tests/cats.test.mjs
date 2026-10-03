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
    if (p.role !== 'student') repo.setUserRole(p.id, p.role);
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

test('图鉴：学生和志愿者都不能改，副主任可以', async () => {
  const ctx = await startTestServer();
  try {
    const anon = await createCat(ctx, undefined, { name: '大橘' });
    assert.equal(anon.status, 401);

    for (const who of ['code-student', 'code-volunteer']) {
      const r = await createCat(ctx, ctx.tokens[who], { name: '大橘' });
      assert.equal(r.status, 403, `${who} 不该能加猫`);
      assert.equal(r.body.error, 'forbidden');
    }

    const ok = await createCat(ctx, ctx.tokens['code-deputy'], { name: '大橘' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.cat.name, '大橘');
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

test('图鉴：管理端页面齐全，门槛收在 session.js 里', () => {
  for (const rel of ['packageAdmin/pages/cats/index', 'packageAdmin/pages/cat-edit/index']) {
    for (const ext of ['.js', '.wxml', '.wxss', '.json']) {
      assert.ok(fs.existsSync(path.join(MP, rel + ext)), `${rel}${ext} 不存在`);
    }
    const js = read(path.join(MP, rel + '.js'));
    assert.match(js, /isManager\(\)/, `${rel} 的门槛要收在 session.js 里`);
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
