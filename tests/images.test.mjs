/**
 * 物品照片：存储、上传接口、静态服务。
 *
 * 这个文件里最要紧的不是「正常路径能传上去」，而是三件事：
 *   1. **文件名由谁决定** —— 只要有任何一处拿客户端传来的字符串拼路径，
 *      就是一个路径穿越漏洞。这里用「正向对照」测：在图片目录**外面**放一个
 *      真实文件，然后试图越过目录去读它。
 *   2. **类型判断看什么** —— 必须看魔术字节。把 .exe 改名成 .jpg 就能骗过去的
 *      检查等于没有检查。
 *   3. **换图会不会留下垃圾** —— 换了图要删旧文件；删文件失败不能影响已经改好的数据。
 *
 * 注意：这里的「图片」是魔术字节正确的构造字节，不是真能解码的图片 ——
 * 服务端只认头部和大小，从不解码（压缩在客户端做），所以这样测的正是它的契约。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/http.mjs';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import { createFakeSessionProvider } from '../server/auth.mjs';
import {
  sniffImage, saveImage, deleteImage, readImage, imageExists, isImageName,
  mimeOfName, imageUrlOf, MAX_IMAGE_BYTES,
} from '../server/images.mjs';

/* ============================================================
   素材
   ============================================================ */

const HEADS = {
  jpg: [0xFF, 0xD8, 0xFF, 0xE0],
  png: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
  gif: [...Buffer.from('GIF89a', 'latin1')],
  // RIFF 后面 4 字节是长度，第 8–11 字节必须是 WEBP —— 只认 RIFF 会把 wav 也放进来
  webp: [...Buffer.from('RIFF', 'latin1'), 0, 0, 0, 0, ...Buffer.from('WEBP', 'latin1')],
};

/** 头部正确、后面填充的字节。服务端不解码，所以这就够了。 */
function fakeImage(kind = 'jpg', size = 64) {
  const head = Buffer.from(HEADS[kind]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 7)]);
}

/* ============================================================
   纯逻辑：类型识别
   ============================================================ */

test('图片：认得出 JPG / PNG / GIF / WebP，且返回对应的扩展名', () => {
  const want = { jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' };
  for (const [kind, ext] of Object.entries(want)) {
    const sig = sniffImage(fakeImage(kind));
    assert.ok(sig, `${kind} 应当被认出来`);
    assert.equal(sig.ext, ext);
  }
});

test('图片：不是图片的东西一律不认', () => {
  const notImages = [
    Buffer.from('这不是图片，只是一段中文文本而已'),
    Buffer.from('GIF', 'latin1'),                          // 太短，连头都不完整
    Buffer.alloc(0),
    Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]),   // .exe（MZ）
    Buffer.from('%PDF-1.4', 'latin1'),                     // PDF
    Buffer.from('RIFF____WAVE', 'latin1'),                 // 是 RIFF，但是 wav 不是 webp
    Buffer.from('<?php echo 1;', 'latin1'),
  ];
  for (const b of notImages) {
    assert.equal(sniffImage(b), null, `不该认成图片：${b.slice(0, 12).toString('latin1')}`);
  }
});

test('图片：content-type 按扩展名给，认不出来给 octet-stream', () => {
  assert.equal(mimeOfName('img_' + 'a'.repeat(32) + '.jpg'), 'image/jpeg');
  assert.equal(mimeOfName('img_' + 'a'.repeat(32) + '.png'), 'image/png');
  assert.equal(mimeOfName('img_' + 'a'.repeat(32) + '.webp'), 'image/webp');
  assert.equal(mimeOfName('随便什么'), 'application/octet-stream');
});

/* ============================================================
   ★ 文件名：这是路径穿越的唯一防线
   ============================================================ */

test('图片：只认服务端生成的文件名，其余一律不认', () => {
  const good = 'img_' + 'a1b2c3d4'.repeat(4) + '.jpg';
  assert.equal(isImageName(good), true, `这个应当是合法的：${good}`);

  const bad = [
    'img_../x.jpg',
    '../secret.jpg',
    '..%2Fsecret.jpg',
    '/etc/passwd',
    'img_' + 'a'.repeat(32) + '.jpg/../../x',
    'img_' + 'a'.repeat(32) + '.php',              // 扩展名不在白名单里
    'img_' + 'A'.repeat(32) + '.jpg',              // 大写十六进制不是我们生成的
    'img_' + 'z'.repeat(32) + '.jpg',
    'img_' + 'a'.repeat(31) + '.jpg',              // 短一位
    'img_' + 'a'.repeat(33) + '.jpg',              // 长一位
    '',
    null,
    undefined,
    123,
  ];
  for (const b of bad) {
    assert.equal(isImageName(b), false, `不该认成合法文件名：${String(b)}`);
  }
});

test('图片：★ 读/删都越不出图片目录（正向对照，不是只试几个字符串）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-imgsec-'));
  const dir = path.join(base, 'images');
  fs.mkdirSync(dir, { recursive: true });

  // 在图片目录**外面**放一个真实文件。如果实现里有任何一处拼路径没校验，
  // 下面这些调用就会把它读出来或删掉。
  const outside = path.join(base, 'secret.jpg');
  fs.writeFileSync(outside, '这是目录外的文件，绝不该被读到');

  try {
    const attempts = ['../secret.jpg', '../../secret.jpg', '..\\secret.jpg', '/etc/passwd'];
    for (const name of attempts) {
      assert.equal(readImage(name, dir), null, `不该读到目录外的文件：${name}`);
      assert.equal(imageExists(name, dir), false, `不该认为目录外的文件存在：${name}`);
      assert.equal(deleteImage(name, dir), false, `不该去删目录外的文件：${name}`);
    }

    // 正向对照：那个文件必须原封不动
    assert.equal(fs.readFileSync(outside, 'utf8'), '这是目录外的文件，绝不该被读到');
    fs.rmSync(base, { recursive: true, force: true });
  } catch (e) {
    fs.rmSync(base, { recursive: true, force: true });
    throw e;
  }
});

/* ============================================================
   落盘
   ============================================================ */

test('图片：存下来的文件名合规、字节一致、能读回来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-img-'));
  try {
    const buf = fakeImage('png', 300);
    const r = saveImage(buf, dir);

    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(isImageName(r.name), true, `生成的文件名不合规：${r.name}`);
    assert.ok(r.name.endsWith('.png'));
    assert.equal(r.bytes, 300);
    assert.equal(r.mime, 'image/png');

    // 读回来的必须是一模一样的字节
    assert.deepEqual(readImage(r.name, dir), buf);
    assert.equal(imageExists(r.name, dir), true);
    assert.equal(imageUrlOf(r.name), `/images/${r.name}`);

    // 目录不存在时也要能自己建出来（线上第一次部署就是这个状态）
    const fresh = path.join(dir, '还没建过');
    assert.equal(saveImage(fakeImage('jpg'), fresh).ok, true);
    assert.equal(fs.existsSync(fresh), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('图片：两次保存不会撞名', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-img-'));
  try {
    const a = saveImage(fakeImage('jpg'), dir);
    const b = saveImage(fakeImage('jpg'), dir);
    assert.notEqual(a.name, b.name, '撞名会让后来的覆盖掉先前的');
    assert.equal(imageExists(a.name, dir) && imageExists(b.name, dir), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('图片：太大 / 不是图片 / 空的，都不能落盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-img-'));
  try {
    const big = Buffer.concat([Buffer.from(HEADS.jpg), Buffer.alloc(MAX_IMAGE_BYTES, 7)]);
    assert.equal(saveImage(big, dir).reason, 'too_large');
    assert.equal(saveImage(Buffer.from('这不是图片'), dir).reason, 'not_image');
    assert.equal(saveImage(Buffer.alloc(0), dir).reason, 'empty');

    // 一次都不该落盘（除了可能残留的临时文件，正式文件不能有）
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('img_')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('图片：删一个不存在的文件不抛错（换图时删旧图必须容错）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-img-'));
  try {
    const name = 'img_' + 'a'.repeat(32) + '.jpg';
    assert.equal(deleteImage(name, dir), false, '文件不存在应当返回 false，而不是抛错');
    assert.equal(deleteImage('乱写的名字', dir), false);
    assert.equal(deleteImage(null, dir), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('图片：图鉴照片走 cats/ 子目录，可读文件名也认', () => {
  // 图鉴的照片是**跟着仓库走的静态资源**（assets/cats/，deploy.sh 同步过去），
  // 文件名是人起的，不是服务端生成的 img_<hex>。
  assert.equal(isImageName('cats/daju.jpg'), true);
  assert.equal(isImageName('cats/cat_01.png'), true);
  assert.equal(isImageName('cats/xiao-hei.webp'), true);

  // 但仍然卡得很紧：扩展名白名单、不许大写、不许再往下一层
  for (const bad of [
    'cats/daju.gif.exe', 'cats/DAJU.jpg', 'cats/.jpg', 'cats/a/b.jpg',
    'cats/../secret.jpg', 'cats/', 'cats', 'cats/daju.BMP',
  ]) {
    assert.equal(isImageName(bad), false, `不该认成合法图鉴照片名：${bad}`);
  }
});

test('图片：★ 图鉴照片名必须是纯 ASCII（中文名会静默 404）', () => {
  // 小程序的 <image> 会把中文名做百分号编码，而我们的静态服务**故意不做
  // URL 解码**（那是为了从一开始就不存在路径穿越）。两边一撞：
  // /images/cats/大橘.jpg 会请求成 /images/cats/%E5%A4%A7... 直接 404，
  // 而界面因为「失败回落 emoji」不报任何错 —— 只看到那只猫一直没照片。
  assert.equal(isImageName('cats/大橘.jpg'), false, '中文名必须被拒，否则是静默 404');
  assert.equal(isImageName('cats/daju 大橘.jpg'), false);
  assert.equal(isImageName('cats/🐱.jpg'), false);
});

test('图片：cats/ 子目录能真的存取', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-catimg-'));
  try {
    const name = 'cats/daju.jpg';
    fs.mkdirSync(path.join(dir, 'cats'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cats', 'daju.jpg'), fakeImage('jpg', 128));

    assert.deepEqual(readImage(name, dir), fakeImage('jpg', 128));
    assert.equal(imageExists(name, dir), true);
    assert.equal(mimeOfName(name), 'image/jpeg');
    assert.equal(imageUrlOf(name), '/images/cats/daju.jpg');

    // 删得掉，而且删不掉目录外的东西
    assert.equal(deleteImage(name, dir), true);
    assert.equal(imageExists(name, dir), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ============================================================
   接口
   ============================================================ */

const SECRET = 'images-test-secret-16c';

const PEOPLE = {
  'code-student': { openid: 'op-s', name: '同学甲', role: 'student' },
  'code-deputy': { openid: 'op-d', name: '二级管理员', role: 'deputy' },
  'code-admin': { openid: 'op-a', name: '一级管理员', role: 'admin' },
};

async function startTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-imgapi-'));
  const dbPath = path.join(dir, 'bazaar.db');
  const imageDir = path.join(dir, 'images');
  fs.mkdirSync(imageDir, { recursive: true });

  const db = openMigrated(dbPath);
  const repo = createSqliteRepository(db);
  const ev = repo.createEvent({ name: '测试义卖', status: 'on_sale' });
  const item = repo.createItem({ eventId: ev.id, name: '手作黄油曲奇', totalQuota: 10 });

  for (const p of Object.values(PEOPLE)) {
    p.id = repo.createUser({ openid: p.openid, name: p.name, role: 'student' }).user.id;
  }
  for (const p of Object.values(PEOPLE)) {
    if (p.role !== 'student') repo.setUserRole(p.id, p.role);
  }
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
    ...srv, dir, imageDir, base, tokens, itemId: item.id,
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
  return { status: res.status, body: json, text, res };
}

const upload = (ctx, token, buf) => call(ctx, 'POST', '/api/admin/image', {
  token, body: { image: buf.toString('base64') },
});

test('照片：学生和游客都不能传', async () => {
  const ctx = await startTestServer();
  try {
    const payload = { image: fakeImage('jpg').toString('base64') };

    const anon = await call(ctx, 'POST', '/api/admin/image', { body: payload });
    assert.equal(anon.status, 401);

    const stu = await call(ctx, 'POST', '/api/admin/image', {
      token: ctx.tokens['code-student'], body: payload,
    });
    assert.equal(stu.status, 403, '学生不该能往服务器上传文件');
    assert.equal(stu.body.error, 'forbidden');
  } finally { await ctx.close(); }
});

test('照片：副主任能传，传完能按 URL 取回一模一样的字节', async () => {
  const ctx = await startTestServer();
  try {
    const buf = fakeImage('png', 500);
    const r = await upload(ctx, ctx.tokens['code-deputy'], buf);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(isImageName(r.body.image), true);
    assert.equal(r.body.bytes, 500);
    assert.equal(r.body.url, `/images/${r.body.image}`);

    // 文件真的落到了配置的那个目录里（不是别处）
    assert.equal(fs.existsSync(path.join(ctx.imageDir, r.body.image)), true);

    // ★ 静态服务要能原样吐回来 —— 开发者工具就是靠这条路径显示图片的
    const got = await fetch(ctx.base + r.body.url);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), buf);
  } finally { await ctx.close(); }
});

test('照片：data: 前缀也能收（有些前端库会带上）', async () => {
  const ctx = await startTestServer();
  try {
    const r = await call(ctx, 'POST', '/api/admin/image', {
      token: ctx.tokens['code-deputy'],
      body: { image: `data:image/jpeg;base64,${fakeImage('jpg').toString('base64')}` },
    });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.ok(r.body.image.endsWith('.jpg'));
  } finally { await ctx.close(); }
});

test('照片：不是图片的内容传不上去', async () => {
  const ctx = await startTestServer();
  try {
    // 一个伪装成图片的文本：客户端说它是 image/jpeg 也没用
    const r = await upload(ctx, ctx.tokens['code-deputy'], Buffer.from('<?php system($_GET[0]); ?>'));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'not_image');
    assert.match(r.body.message, /JPG|PNG/, '要直接告诉他支持哪些格式');

    // 一次都不该落盘
    assert.deepEqual(fs.readdirSync(ctx.imageDir).filter((f) => f.startsWith('img_')), []);

    const missing = await call(ctx, 'POST', '/api/admin/image', {
      token: ctx.tokens['code-deputy'], body: {},
    });
    assert.equal(missing.status, 400);
  } finally { await ctx.close(); }
});

test('照片：超过上限的请求返回 413，而不是把连接掐掉', async () => {
  const ctx = await startTestServer();
  try {
    // 造一个比上限大得多的 base64。真正的图片不至于这么大，
    // 但「压缩没生效」时会走到这里 —— 要给出能看懂的错，而不是网络错误。
    const huge = Buffer.concat([
      Buffer.from(HEADS.jpg), Buffer.alloc(MAX_IMAGE_BYTES + 1024, 7),
    ]).toString('base64');

    const r = await call(ctx, 'POST', '/api/admin/image', {
      token: ctx.tokens['code-deputy'], body: { image: huge },
    });
    assert.equal(r.status, 413, `应当是 413，实际 ${r.status}`);
    assert.equal(r.body.error, 'too_large');
    assert.match(r.body.message, /KB/, '要说清楚上限是多少');
  } finally { await ctx.close(); }
});

test('照片：静态服务拿不到目录外的文件', async () => {
  const ctx = await startTestServer();
  try {
    for (const p of [
      '/images/../bazaar.db',
      '/images/..%2F..%2Fbazaar.db',
      '/images/%2e%2e%2fbazaar.db',
      '/images/不存在.jpg',
      '/images/',
    ]) {
      const r = await fetch(ctx.base + p);
      assert.equal(r.status, 404, `${p} 应当是 404，实际 ${r.status}`);
    }
  } finally { await ctx.close(); }
});

test('照片：图鉴的 cats/ 能通过 HTTP 取到，中文名取不到', async () => {
  const ctx = await startTestServer();
  try {
    // 模拟 deploy.sh 把 assets/cats/ 同步过来的结果
    fs.mkdirSync(path.join(ctx.imageDir, 'cats'), { recursive: true });
    const buf = fakeImage('jpg', 300);
    fs.writeFileSync(path.join(ctx.imageDir, 'cats', 'daju.jpg'), buf);

    const ok = await fetch(`${ctx.base}/images/cats/daju.jpg`);
    assert.equal(ok.status, 200, '图鉴照片必须能取到，否则界面只剩 emoji');
    assert.equal(ok.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), buf);

    // ★ 反向对照：中文名会被小程序百分号编码，而静态服务不做 URL 解码
    // （不解释放它是为了从根上杜绝路径穿越）。所以这条请求必须 404 ——
    // 如果哪天有人「顺手加个 decodeURIComponent」，这个测试会先红。
    const bad = await fetch(`${ctx.base}/images/cats/大橘.jpg`);
    assert.equal(bad.status, 404, '中文名的图鉴照片是取不到的，命名必须用 ASCII');
  } finally { await ctx.close(); }
});

test('照片：建物品时可以带上图片', async () => {
  const ctx = await startTestServer();
  try {
    const up = await upload(ctx, ctx.tokens['code-deputy'], fakeImage('jpg'));
    const r = await call(ctx, 'POST', '/api/admin/item/create', {
      token: ctx.tokens['code-deputy'],
      body: { name: '多肉小盆栽', totalQuota: 3, image: up.body.image },
    });

    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.item.image, up.body.image);

    // 学生那头的列表里也要带着它，否则详情页没图可显示
    const list = await call(ctx, 'GET', '/api/items');
    assert.equal(list.body.items.find((x) => x.name === '多肉小盆栽').image, up.body.image);

    // 不传图片就是没有图片 —— 界面回落到 emoji
    const plain = await call(ctx, 'POST', '/api/admin/item/create', {
      token: ctx.tokens['code-deputy'], body: { name: '手写书签', totalQuota: 5 },
    });
    assert.equal(plain.body.item.image, null);
  } finally { await ctx.close(); }
});

test('照片：★ 指向不存在的图片要拒绝，不能留下一个破图', async () => {
  const ctx = await startTestServer();
  try {
    const ghost = 'img_' + 'a'.repeat(32) + '.jpg';
    const r = await call(ctx, 'POST', '/api/admin/item/create', {
      token: ctx.tokens['code-deputy'],
      body: { name: '幽灵物品', totalQuota: 3, image: ghost },
    });
    assert.equal(r.status, 400, '文件名合法但文件不在，也必须拒绝');
    assert.equal(r.body.error, 'bad_request');

    // 界面判断「有没有图」看的就是这个字段 —— 存了名字而文件不在，
    // 显示的是一个破图标，而且**不会**回落到 emoji。所以宁可当时就拒绝。
    const list = await call(ctx, 'GET', '/api/items');
    assert.equal(list.body.items.some((x) => x.name === '幽灵物品'), false);
  } finally { await ctx.close(); }
});

test('照片：换图会把旧文件删掉，清空图片也会', async () => {
  const ctx = await startTestServer();
  try {
    const t = ctx.tokens['code-deputy'];

    const first = await upload(ctx, t, fakeImage('jpg'));
    await call(ctx, 'POST', '/api/admin/item', {
      token: t, body: { itemId: ctx.itemId, image: first.body.image },
    });
    const oldPath = path.join(ctx.imageDir, first.body.image);
    assert.equal(fs.existsSync(oldPath), true);

    // 换成另一张：新文件在、旧文件没了
    const second = await upload(ctx, t, fakeImage('png'));
    const swapped = await call(ctx, 'POST', '/api/admin/item', {
      token: t, body: { itemId: ctx.itemId, image: second.body.image },
    });
    assert.equal(swapped.body.item.image, second.body.image);
    assert.equal(fs.existsSync(path.join(ctx.imageDir, second.body.image)), true);
    assert.equal(fs.existsSync(oldPath), false, '换了图之后旧文件不该留着占地方');

    // 清空：值为 null，文件也没了
    const cleared = await call(ctx, 'POST', '/api/admin/item', {
      token: t, body: { itemId: ctx.itemId, image: null },
    });
    assert.equal(cleared.body.ok, true, JSON.stringify(cleared.body));
    assert.equal(cleared.body.item.image, null);
    assert.equal(fs.existsSync(path.join(ctx.imageDir, second.body.image)), false);
  } finally { await ctx.close(); }
});

test('照片：不提 image 时就不该动它（三态里的「不动」）', async () => {
  const ctx = await startTestServer();
  try {
    const t = ctx.tokens['code-deputy'];
    const up = await upload(ctx, t, fakeImage('jpg'));
    await call(ctx, 'POST', '/api/admin/item', {
      token: t, body: { itemId: ctx.itemId, image: up.body.image },
    });

    // 只改名额，不碰图片 —— 这是最常走的一条路，绝不能顺手把图清了
    const r = await call(ctx, 'POST', '/api/admin/item', {
      token: t, body: { itemId: ctx.itemId, quotaDelta: 2 },
    });
    assert.equal(r.body.item.image, up.body.image, '不传 image 就该保持原样');
    assert.equal(fs.existsSync(path.join(ctx.imageDir, up.body.image)), true);
  } finally { await ctx.close(); }
});

test('照片：只改图片也算「有内容要改」，不会被当成空请求', async () => {
  const ctx = await startTestServer();
  try {
    const t = ctx.tokens['code-deputy'];
    const up = await upload(ctx, t, fakeImage('jpg'));

    const r = await call(ctx, 'POST', '/api/admin/item', {
      token: t, body: { itemId: ctx.itemId, image: up.body.image },
    });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));

    // 真的什么都没有时仍然要拒
    const empty = await call(ctx, 'POST', '/api/admin/item', {
      token: t, body: { itemId: ctx.itemId },
    });
    assert.equal(empty.status, 400);
  } finally { await ctx.close(); }
});

test('照片：上传会留操作日志', async () => {
  const ctx = await startTestServer();
  try {
    const r = await upload(ctx, ctx.tokens['code-deputy'], fakeImage('jpg', 128));
    const row = ctx.db.prepare(
      "SELECT * FROM audit_logs WHERE action = 'image.upload' ORDER BY id DESC LIMIT 1"
    ).get();
    assert.ok(row, '传图要留日志');
    assert.equal(row.target_id, r.body.image);
    assert.equal(JSON.parse(row.detail).bytes, 128);
  } finally { await ctx.close(); }
});
