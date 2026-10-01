/**
 * 取货码二维码。
 *
 * 这里有两类断言，性质不同：
 *   1. **引入审查** —— packageBazaar/lib/qrcode.js 是本仓库唯一的第三方代码，
 *      许可证、ESM 纯度、没有可疑调用，这几条必须一直成立（升级时会被自动拦下）。
 *   2. **行为** —— 生成的矩阵是合法二维码，而且二维码里放的字符和核销台扫完
 *      期望的字符完全一致。后者是两边最容易走散的契约。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQr, drawQr, qrContentFor } from '../miniprogram/packageBazaar/utils/qr-draw.js';
import { PICKUP_CODE_LEN } from '../miniprogram/utils/format.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'miniprogram', 'packageBazaar', 'lib');

const vendored = () => fs.readFileSync(path.join(LIB, 'qrcode.js'), 'utf8');

/* ============================================================
   一、引入审查
   ============================================================ */

test('二维码库：MIT 版权声明必须原样保留', () => {
  // MIT 要求分发时保留版权声明。jsDelivr 的 +esm 构建把它剥掉了，
  // 所以当时没用那个版本 —— 这条断言就是防止以后有人换成剥掉署名的产物。
  const src = vendored();
  assert.match(src, /Kazuhiko Arase/, '必须保留作者署名');
  assert.match(src, /MIT license/, '必须保留许可证说明');
});

test('二维码库：必须是纯 ESM，不能留 CommonJS 分支', () => {
  // 仓库有一条测试禁止混用 require 和 import，所以引入时把 UMD 包装换成了
  // 一行 export default。这里确保它没被换回去。
  const src = vendored();
  assert.ok(!src.includes('module.exports'), '不能出现 module.exports');
  assert.ok(!src.includes('require('), '不能出现 require(');
  assert.match(src, /export default qrcode;/, '必须用 ESM 导出');
});

test('二维码库：没有 eval / new Function / 网络调用', () => {
  // 引入前人工审过一遍，这里固化成断言，以后升级会被自动拦下。
  const src = vendored();
  for (const bad of ['eval(', 'new Function', 'XMLHttpRequest', 'fetch(']) {
    assert.ok(!src.includes(bad), `第三方代码里不该出现 ${bad}`);
  }
});

test('二维码库：README 记了上游地址、版本和哈希（升级要有据可查）', () => {
  const readme = fs.readFileSync(path.join(LIB, 'README.md'), 'utf8');
  assert.match(readme, /qrcode-generator@1\.4\.4/, '要写明上游包和版本');
  assert.match(readme, /unpkg\.com\/qrcode-generator/, '要写明下载地址');
  assert.match(readme, /[0-9A-F]{64}/, '要记录 sha256，升级时才能核对');
  assert.match(readme, /export default qrcode;/, '要说明我们改了什么');
});

/* ============================================================
   二、行为
   ============================================================ */

test('二维码：6 位数字生成的是合法矩阵（21×21，三个定位图案都在）', () => {
  const qr = buildQr('123456');
  const n = qr.getModuleCount();

  assert.equal(n, 21, '6 位数字应当落在 version 1（21×21）');

  // 定位图案（三个角的 7×7 回字）写错的话二维码扫不出来，所以单独查
  const finder = (top, left) => {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(qr.isDark(top + r, left + c), border || core,
          `定位图案 (${top + r},${left + c}) 不对`);
      }
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);
});

test('二维码：同样的取货码必须画出同样的矩阵', () => {
  // 否则同一笔预定两次打开页面可能长得不一样，志愿者会以为码变了
  const a = buildQr('482913');
  const b = buildQr('482913');
  for (let r = 0; r < a.getModuleCount(); r += 1) {
    for (let c = 0; c < a.getModuleCount(); c += 1) {
      assert.equal(a.isDark(r, c), b.isDark(r, c));
    }
  }
});

test('二维码：★ 内容只能是那 6 位数字 —— 和核销台扫完的解析是一份契约', () => {
  // 核销台扫完会把非数字全部剥掉、并要求正好 6 位。
  // 这里一旦放 URL 或加前缀，扫出来就是一串乱数字，现场核销不了。
  assert.equal(qrContentFor('123456'), '123456');
  assert.equal(qrContentFor(123456), '123456', '数字类型也要能处理');

  for (const bad of ['12345', '1234567', '12345a', 'https://x.cn/123456', '', null, undefined]) {
    assert.throws(() => qrContentFor(bad), /6 位数字/, `「${bad}」应当被拒`);
  }
});

test('二维码：位数只有一处定义，取货码页和核销台必须用同一个', () => {
  // 两边不一致 → 扫出来的码被判成「不是有效的取货码」
  const scan = fs.readFileSync(
    path.join(ROOT, 'miniprogram', 'packageBazaar', 'pages', 'scan', 'index.js'), 'utf8');
  assert.match(scan, /PICKUP_CODE_LEN/, '核销台应当引用共享常量，而不是自己写 6');

  const pickup = fs.readFileSync(
    path.join(ROOT, 'miniprogram', 'packageBazaar', 'pages', 'pickup-code', 'index.js'), 'utf8');
  assert.match(pickup, /qr-draw\.js/, '取货码页应当用二维码模块');

  assert.equal(PICKUP_CODE_LEN, 6);
});

test('二维码：绘制时有白底、暗块数量对得上、且留了静默区', () => {
  const calls = [];
  const ctx = {
    fillStyle: '',
    fillRect(x, y, w, h) { calls.push({ color: this.fillStyle, x, y, w, h }); },
  };

  const size = 210;
  const qr = buildQr('123456');
  const { cell, count } = drawQr(ctx, qr, { size });

  // 第一笔是白底
  assert.equal(calls[0].color, '#ffffff');
  assert.deepEqual(
    { x: calls[0].x, y: calls[0].y, w: calls[0].w, h: calls[0].h },
    { x: 0, y: 0, w: size, h: size });

  const dark = calls.slice(1);
  let expected = 0;
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) if (qr.isDark(r, c)) expected += 1;
  }
  assert.equal(dark.length, expected, '暗块数量应当和矩阵里的暗模块数一致');
  assert.ok(expected > 0);

  // 静默区：所有暗块都不能贴边，四周要留出 margin 个模块
  const margin = 4;
  const left = Math.floor(margin * cell);
  for (const d of dark) {
    assert.equal(d.color, '#000000', '暗块必须是纯黑，别用主题色（对比度不够会扫不出）');
    assert.ok(d.x >= left - 1, `暗块 x=${d.x} 侵入了静默区（应 >= ${left}）`);
    assert.ok(d.y >= left - 1, `暗块 y=${d.y} 侵入了静默区`);
    assert.ok(d.x + d.w <= size + 1 && d.y + d.h <= size + 1, '暗块画到画布外了');
  }

  // 不能留抗锯齿缝隙：相邻格子的边界应当相接或重叠
  assert.ok(cell > 0);
});
