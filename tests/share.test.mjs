/**
 * 分享接口（onShareAppMessage / onShareTimeline）。
 *
 * 正式版发出去才发现「没有转发按钮」—— 右上角菜单里的「转发」默认是灰的，
 * 因为页面没实现 onShareAppMessage。这不是认证问题：**分享是基础能力**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(p, 'utf8');

/** 该有分享的页面。首页/图鉴是整站分享，两个详情页分享具体那一条。 */
const PAGES = [
  'pages/home/index',
  'pages/cats/index',
  'packageBazaar/pages/detail/index',
  'packageCats/pages/detail/index',
];

test('分享：关键页面都实现了 onShareAppMessage', () => {
  for (const p of PAGES) {
    const js = read(path.join(MP, p + '.js'));
    assert.match(js, /onShareAppMessage\(\)\s*\{/, `${p} 没实现 onShareAppMessage —— 转发按钮会是灰的`);
    assert.match(js, /from '.*utils\/share\.js'/, `${p} 应该复用 utils/share.js 的文案`);
  }
});

test('分享：详情页要带上 id，点开直达那一件/那只', () => {
  const bazaar = read(path.join(MP, 'packageBazaar/pages/detail/index.js'));
  assert.match(bazaar, /shareItem\(this\.data\.item\)/, '物品详情要分享当前这件');

  const cat = read(path.join(MP, 'packageCats/pages/detail/index.js'));
  assert.match(cat, /shareCat\(this\.data\.cat\)/, '猫详情要分享当前这只');

  const share = read(path.join(MP, 'utils/share.js'));
  assert.match(share, /packageBazaar\/pages\/detail\/index\?id=/, '物品分享路径要带 id');
  assert.match(share, /packageCats\/pages\/detail\/index\?id=/, '猫分享路径要带 id');
  assert.match(share, /encodeURIComponent/, 'id 要 encode，别拼出坏路径');
});

test('分享：卡片图优先用物品/猫自己的照片', async () => {
  // 不传 imageUrl 时微信会截当前页面当卡片图，经常截到公告条或空白
  const { shareItem, shareCat } = await import('../miniprogram/utils/share.js');

  const withImage = shareItem({ id: 'it_1', name: '手作书签', image: 'img_ab.jpg' });
  assert.ok(withImage.imageUrl, '有照片就要带上卡片图');
  assert.match(withImage.imageUrl, /img_ab\.jpg$/);

  const noImage = shareItem({ id: 'it_2', name: '旧物' });
  assert.equal(noImage.imageUrl, undefined, '没照片就别塞空串，交给微信截图');

  // 页面已经算好 imageUrl 的（详情页就是这么干的）直接用
  const precomputed = shareCat({ id: 'c_1', name: '大橘', imageUrl: 'https://x/y.jpg' });
  assert.equal(precomputed.imageUrl, 'https://x/y.jpg');
});

test('分享：朋友圈卡片也要配图（朋友圈是看图的地方）', async () => {
  const { timeline } = await import('../miniprogram/utils/share.js');

  const withImage = timeline({ id: 'c_1', name: '大橘', image: 'img_ab.jpg' });
  assert.ok(withImage.imageUrl, '朋友圈卡片要带图');
  assert.equal(withImage.query, 'id=c_1', 'query 不带问号');

  const noImage = timeline({ id: 'c_2', name: '独眼大侠' });
  assert.equal(noImage.imageUrl, undefined, '没图就别塞空串');
  assert.equal(noImage.title, '独眼大侠 · 盛师猫猫');
});

test('分享：文案里不许出现交易/金额口径', () => {
  // 这些字会出现在转发卡片上 —— 和界面同一个合规口径
  const share = read(path.join(MP, 'utils/share.js'));
  const banned = ['义卖', '公益', '慈善', '价格', '金额', '收费', '捐款'];
  const hit = banned.filter((w) => share.includes(w));
  assert.deepEqual(hit, [], `分享文案里有不该出现的词：${hit.join('、')}`);
});

test('分享：朋友圈接口也有（onShareTimeline，基础库 2.11.3+）', () => {
  for (const p of PAGES) {
    const js = read(path.join(MP, p + '.js'));
    assert.match(js, /onShareTimeline\(\)\s*\{/, `${p} 没实现 onShareTimeline`);
  }
});
