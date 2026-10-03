/**
 * 图鉴照片的覆盖逻辑。
 *
 * 这是「管理员在小程序里换照片」这条链路上**唯一有判断的地方**：
 *   · 有覆盖用覆盖，没有就用仓库那张；
 *   · 拉不到覆盖表时**不能**把缓存清掉，也不能把已有照片弄没。
 *
 * 所以这里不靠读源码断言，而是把 platform 换成假的、真的把逻辑跑一遍 ——
 * 见 services/platform.js 的 setPlatform（它存在就是为了这个）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setPlatform, resetPlatform, originalPlatform } from '../miniprogram/services/platform.js';
import * as catPhotos from '../miniprogram/services/cat-photos.js';
import { BASE_URL } from '../miniprogram/config.js';

/**
 * 把 platform 换成一份可控的假实现。
 *
 * ★ 必须 await（内部是 async，finally 要在 fn 跑完之后才还原）。
 *   写成同步的话，fn 里的断言失败只会变成一个没人接的 Promise rejection ——
 *   测试反而「通过」了，比不写还糟。
 */
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

/** 一个成功的 /api/cat-photos 响应 */
const okWith = (photos) => async () => ({ statusCode: 200, data: { ok: true, photos } });

/* ============================================================
   优先级：有覆盖用覆盖，没有用仓库那张
   ============================================================ */

test('图鉴照片：有覆盖用覆盖，没有就用仓库里那张', async () => {
  const cat = { id: 'c1', name: '大橘', image: 'cats/daju.jpg' };

  assert.equal(catPhotos.withPhoto(cat, { c1: 'img_aa.jpg' }).photo,
    `${BASE_URL}/images/img_aa.jpg`, '有覆盖时必须用覆盖');

  assert.equal(catPhotos.withPhoto(cat, {}).photo,
    `${BASE_URL}/images/cats/daju.jpg`, '没有覆盖时要回落到仓库那张');

  // 覆盖表里是**别的猫**，不该串到这只身上
  assert.equal(catPhotos.withPhoto(cat, { c2: 'img_bb.jpg' }).photo,
    `${BASE_URL}/images/cats/daju.jpg`);
});

test('图鉴照片：仓库那张也没有时是空串（界面据此回落 emoji）', async () => {
  // ★ 必须是空串而不是 null / undefined：模板里的判断是 `item.photo &&`，
  //   而 utils/format.js 的 imageUrl() 约定「没有照片就返回空串」。
  const bare = { id: 'c9', name: '还没拍照的猫', image: null };
  assert.equal(catPhotos.withPhoto(bare, {}).photo, '');
  assert.equal(catPhotos.withPhoto(bare, { c9: 'img_cc.jpg' }).photo,
    `${BASE_URL}/images/img_cc.jpg`);
});

test('图鉴照片：坏掉的覆盖值不许拼进地址（不能变成 /images/[object Object]）', async () => {
  const cat = { id: 'c1', name: '大橘', image: 'cats/daju.jpg' };

  for (const bad of [null, undefined, '', 0, {}, [], 'x'.repeat(5000), '有 空格.jpg']) {
    const got = catPhotos.withPhoto(cat, { c1: bad }).photo;
    assert.equal(got, `${BASE_URL}/images/cats/daju.jpg`,
      `覆盖值是 ${JSON.stringify(bad)?.slice(0, 20)} 时应当回落到仓库那张`);
    assert.ok(!/undefined|null|object/i.test(got), `地址里不该出现怪东西：${got}`);
  }
});

/* ============================================================
   缓存：先用缓存渲染，拿不到就别动
   ============================================================ */

test('图鉴照片：cached() 读得到上次成功的结果', async () => {
  await withFakePlatform({}, (store) => {
    store.set(catPhotos.STORAGE_KEY, { c1: 'img_aa.jpg' });
    assert.deepEqual(catPhotos.cached(), { c1: 'img_aa.jpg' });
  });
});

test('图鉴照片：缓存坏掉时当成「没有缓存」，不许抛错', async () => {
  // 存储内容被手改过、或者换了格式 —— 图鉴页不能因此白屏
  for (const junk of ['一个字符串', 123, [], null, { c1: 123 }, { c1: '' }, { '': 'img_a.jpg' }]) {
    await withFakePlatform({}, (store) => {
      store.set(catPhotos.STORAGE_KEY, junk);
      assert.doesNotThrow(() => catPhotos.cached());
      assert.deepEqual(catPhotos.cached(), {},
        `缓存是 ${JSON.stringify(junk)} 时应当当成空表`);
    });
  }
});

test('图鉴照片：拉成功要写缓存', async () => {
  await withFakePlatform({ request: okWith({ c1: 'img_aa.jpg' }) }, async (store) => {
    const got = await catPhotos.fetch();
    assert.deepEqual(got, { c1: 'img_aa.jpg' });
    assert.deepEqual(store.get(catPhotos.STORAGE_KEY), { c1: 'img_aa.jpg' },
      '成功的结果要存下来，下次冷启动先用它渲染');
  });
});

test('图鉴照片：★ 拉失败要返回 null，而且绝不能碰缓存', async () => {
  // 这是整个功能最要命的一条：如果失败时返回 {} 并写进缓存，
  // 那么一次断网就会把「管理员的覆盖」从本地抹掉 ——
  // 界面上表现为「照片自己变回旧的了」，而服务端其实好好的。
  for (const fail of [
    async () => { throw new Error('断网'); },
    async () => ({ statusCode: 500, data: { ok: false, error: 'internal', message: '炸了' } }),
    async () => ({ statusCode: 200, data: null }),                     // 代理返回了 HTML
    async () => ({ statusCode: 404, data: { ok: false, error: 'not_found' } }),
  ]) {
    await withFakePlatform({ request: fail }, async (store) => {
      const before = { c1: 'img_aa.jpg' };
      store.set(catPhotos.STORAGE_KEY, before);

      const got = await catPhotos.fetch();

      assert.equal(got, null, '失败必须是 null —— 好和「服务端说没有覆盖」区分开');
      assert.deepEqual(store.get(catPhotos.STORAGE_KEY), before, '失败时缓存必须原封不动');
      assert.deepEqual(catPhotos.cached(), before);
    });
  }
});

test('图鉴照片：服务端说「没有覆盖」和「没问到」是两件事', async () => {
  // 空表是**成功**的结果：管理员把照片都恢复默认了，缓存就该跟着变空。
  await withFakePlatform({ request: okWith({}) }, async (store) => {
    store.set(catPhotos.STORAGE_KEY, { c1: 'img_aa.jpg' });
    const got = await catPhotos.fetch();
    assert.deepEqual(got, {}, '空表是成功结果，不是失败');
    assert.deepEqual(store.get(catPhotos.STORAGE_KEY), {},
      '服务端说没有覆盖了，缓存也要跟着清 —— 不然界面一直显示被删掉的那张');
  });
});

test('图鉴照片：拼出来的地址能直接给 <image> 用', async () => {
  // 换服务器时只改 config.js 一处；这里确认拼出来的确实是 BASE_URL + /images/
  await withFakePlatform({ request: okWith({ c1: 'img_aa.jpg' }) }, async () => {
    const photos = await catPhotos.fetch();
    const photo = catPhotos.withPhoto({ id: 'c1', image: null }, photos).photo;
    assert.equal(photo, `${BASE_URL}/images/img_aa.jpg`);
    assert.match(photo, /^https?:\/\//, '应当是一个可以直接给 <image> 用的地址');
  });
});
