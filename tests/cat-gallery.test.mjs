/**
 * 图鉴相册（多图）。
 *
 * 一只猫可以有多张照片：主图（cats.image）是列表页用的那张，相册（cats_images）
 * 只在详情页展示。旧图鉴导进来时带着 2–5 张在校照片，这个功能就是为它做的。
 *
 * 直接调 repo / api，不起 HTTP —— 鉴权和传输有别的测试守着。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import { createApi, CAT_IMAGES_MAX } from '../server/api.mjs';

/**
 * 一个临时图片目录 + 若干「看起来合法」的图片文件。
 * 文件名必须过 isImageName（img_ + 32 位十六进制 + 扩展名），否则 imageExists 直接 false。
 */
function makeImages(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-gallery-'));
  const names = [];
  for (let i = 0; i < n; i++) {
    const name = `img_${String(i).padStart(32, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, name), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]));
    names.push(name);
  }
  return { dir, names };
}

function fixture(imageCount = 3) {
  const db = openMigrated(':memory:');
  const repo = createSqliteRepository(db);
  const { dir, names } = makeImages(imageCount);

  const api = createApi({
    repo,
    secret: 'test-secret-0123456789abcdef',
    signToken: () => 'token',
    makeCode: () => '123456',
    imageDir: dir,
  });

  const user = repo.createUser({ openid: 'op-1', name: '同学甲' }).user;
  repo.setUserRole(user.id, 'volunteer');
  const staff = repo.findUserById(user.id);

  const cat = repo.createCat({ name: '大橘' }).cat;

  return { db, repo, api, dir, names, user, staff, cat, close: () => db.close() };
}

test('相册：repo 能设置、替换、清空，并回报被移出的文件', () => {
  const ctx = fixture();
  try {
    const [a, b, c] = ctx.names;

    let r = ctx.repo.setCatImages(ctx.cat.id, [a, b]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.images.map((x) => x.image), [a, b], '顺序就是传进来的顺序');
    assert.deepEqual(r.removed, []);

    r = ctx.repo.setCatImages(ctx.cat.id, [c]);
    assert.deepEqual(r.images.map((x) => x.image), [c]);
    assert.deepEqual(r.removed.sort(), [a, b].sort(), '被替换掉的要告诉调用方，好删磁盘文件');

    r = ctx.repo.setCatImages(ctx.cat.id, []);
    assert.deepEqual(r.images, []);
    assert.deepEqual(r.removed, [c]);
  } finally { ctx.close(); }
});

test('相册：不存在的猫 / 删猫会带走相册', () => {
  const ctx = fixture();
  try {
    assert.equal(ctx.repo.setCatImages('cat_不存在', [ctx.names[0]]).ok, false);

    ctx.repo.setCatImages(ctx.cat.id, [ctx.names[0], ctx.names[1]]);
    const del = ctx.repo.deleteCat(ctx.cat.id);
    assert.equal(del.ok, true);
    assert.equal(del.images.length, 2, '要回报相册里的文件，调用方才知道删哪些');
    assert.deepEqual(ctx.repo.listCatImages(ctx.cat.id), [], '猫没了，相册不能留残留');
    assert.deepEqual(ctx.repo.listCatImages(), []);
  } finally { ctx.close(); }
});

test('相册：公开接口每只猫都带上 images（不是 42 次查询）', () => {
  const ctx = fixture();
  try {
    ctx.repo.setCatImages(ctx.cat.id, [ctx.names[0], ctx.names[1]]);
    const r = ctx.api.listCats();
    const one = r.body.cats.find((c) => c.id === ctx.cat.id);
    assert.deepEqual(one.images, [ctx.names[0], ctx.names[1]]);

    const other = ctx.repo.createCat({ name: '小黑' }).cat;
    const r2 = ctx.api.listCats();
    assert.deepEqual(r2.body.cats.find((c) => c.id === other.id).images, [],
      '没有相册的猫给空数组，不是 undefined —— 客户端少判一个 undefined');
  } finally { ctx.close(); }
});

test('相册：管理端整体替换；空数组 = 清空', () => {
  const ctx = fixture();
  try {
    const r = ctx.api.adminUpdateCat({
      body: { catId: ctx.cat.id, images: [ctx.names[0], ctx.names[1]] },
      user: ctx.staff,
    });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.deepEqual(r.body.images, [ctx.names[0], ctx.names[1]]);

    const cleared = ctx.api.adminUpdateCat({
      body: { catId: ctx.cat.id, images: [] },
      user: ctx.staff,
    });
    assert.deepEqual(cleared.body.images, []);
  } finally { ctx.close(); }
});

test('相册：不存在的图片、超上限的数组，都要拒', () => {
  const ctx = fixture(CAT_IMAGES_MAX + 1);
  try {
    const ghost = ctx.api.adminUpdateCat({
      body: { catId: ctx.cat.id, images: ['img_' + 'f'.repeat(32) + '.jpg'] },
      user: ctx.staff,
    });
    assert.equal(ghost.status, 400, '磁盘上没有的图不能进相册，否则就是破图');

    const tooMany = ctx.api.adminUpdateCat({
      body: { catId: ctx.cat.id, images: ctx.names.slice(0, CAT_IMAGES_MAX + 1) },
      user: ctx.staff,
    });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.message, new RegExp(String(CAT_IMAGES_MAX)));

    const notArray = ctx.api.adminUpdateCat({
      body: { catId: ctx.cat.id, images: ctx.names[0] },
      user: ctx.staff,
    });
    assert.equal(notArray.status, 400);
  } finally { ctx.close(); }
});

test('相册：建猫时也能直接带图', () => {
  const ctx = fixture();
  try {
    const r = ctx.api.adminCreateCat({
      body: { name: '新来的', images: [ctx.names[0]] },
      user: ctx.staff,
    });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.deepEqual(r.body.images, [ctx.names[0]]);
    assert.deepEqual(ctx.repo.listCatImages(r.body.cat.id).map((x) => x.image), [ctx.names[0]]);
  } finally { ctx.close(); }
});
