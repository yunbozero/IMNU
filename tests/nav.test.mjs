/**
 * 自定义导航栏的尺寸。
 *
 * 图鉴详情页用「沉浸式大图」（navigationStyle: custom），自己画导航栏，
 * 所以要算准状态栏高度和右上角胶囊的位置 —— 算错了标题会被胶囊压住，
 * 或者内容顶进刘海。这部分是纯函数，能直接测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeNavMetrics, NAV_FALLBACK } from '../miniprogram/utils/nav.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(p, 'utf8');

test('导航栏：取不到系统信息时给保守值，不能算出 0 或 NaN', () => {
  for (const input of [undefined, {}, { systemInfo: null }, { menuButton: null }]) {
    const m = computeNavMetrics(input);
    assert.equal(m.statusBarHeight, NAV_FALLBACK.statusBarHeight);
    assert.ok(m.navBarHeight > 40, '导航栏总高度必须是个能用的正数');
    assert.ok(Number.isFinite(m.contentTop));
    assert.ok(Number.isFinite(m.menuReserveWidth));
  }
});

test('导航栏：有胶囊位置时按「状态栏 + 空隙 + 胶囊高」算', () => {
  const m = computeNavMetrics({
    systemInfo: { statusBarHeight: 44, windowWidth: 375 },
    menuButton: { top: 48, height: 32, width: 87, right: 300 },
  });

  // topGap = max(48 - 44, 6) = 6
  assert.equal(m.contentTop, 50);
  assert.equal(m.contentHeight, 32);
  assert.equal(m.navBarHeight, 50 + 32 + 6);
  // 右侧要给胶囊让出「胶囊宽 + 到右边距离 + 余量」
  assert.equal(m.menuReserveWidth, 87 + (375 - 300) + 8);
});

test('导航栏：胶囊贴得太近时空隙至少 6', () => {
  const m = computeNavMetrics({
    systemInfo: { statusBarHeight: 44, windowWidth: 375 },
    menuButton: { top: 45, height: 32, width: 87, right: 300 },
  });
  assert.equal(m.contentTop, 50, 'topGap 被夹到 6，内容不会贴到状态栏上');
});

test('导航栏：图鉴详情页真的用了自定义导航（json + 返回键都接上）', () => {
  const cfg = JSON.parse(read(path.join(MP, 'packageCats/pages/detail/index.json')));
  assert.equal(cfg.navigationStyle, 'custom', '不开这个，默认导航栏会和自绘的那条叠在一起');

  const wxml = read(path.join(MP, 'packageCats/pages/detail/index.wxml'));
  assert.match(wxml, /bindtap="goBack"/, '自绘导航栏要有返回键');
  assert.match(wxml, /nav\.navBarHeight/, '内容要按导航栏高度往下让，否则会被盖住');
  assert.match(wxml, /nav\.menuReserveWidth/, '右侧要给胶囊留位置，否则标题被压');

  const js = read(path.join(MP, 'packageCats/pages/detail/index.js'));
  assert.match(js, /getNavMetrics/, '尺寸要从 utils/nav.js 取，不要各页面各算一遍');
  assert.match(js, /getCurrentPages\(\)/, '没有上一页时（分享直接进来）要能回首页');
});
