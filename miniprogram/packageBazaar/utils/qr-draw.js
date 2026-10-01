/**
 * 取货码二维码：生成矩阵 + 画到 canvas。
 *
 * 编码器是引入的第三方库，来历和改动见 `packageBazaar/lib/README.md`。
 * 这个文件只做两件事：用它生成矩阵、把矩阵画出来。都是纯逻辑，
 * 所以能在 Node 里直接测 —— 页面里「取 canvas 节点」那步没法测，那部分留在页面里。
 */
import qrcode from '../lib/qrcode.js';
import { PICKUP_CODE_LEN } from '../../utils/format.js';

/** 纠错等级 M（约 15% 容错）。二维码脏一点、屏幕反光也可能扫不出来，留点余量。 */
const ECC = 'M';

/**
 * 二维码里到底放什么字符。
 *
 * ★ 只放取货码本身的 6 位数字，**不要**加前缀、URL 或任何别的字符。
 *   核销台扫完会把非数字全部剥掉、并要求正好 PICKUP_CODE_LEN 位
 *   （见 packageBazaar/pages/scan/index.js）。要是这里放个 URL，
 *   剥完只剩一串乱七八糟的数字，扫了也核销不了。
 *   这条契约有测试盯着。
 */
export function qrContentFor(code) {
  const s = String(code === null || code === undefined ? '' : code).trim();
  const re = new RegExp(`^\\d{${PICKUP_CODE_LEN}}$`);
  if (!re.test(s)) {
    throw new Error(`取货码必须是 ${PICKUP_CODE_LEN} 位数字`);
  }
  return s;
}

/** 生成二维码矩阵。返回的对象有 getModuleCount() / isDark(r,c) */
export function buildQr(code) {
  const qr = qrcode(0, ECC);            // 0 = 自动选最小版本
  qr.addData(qrContentFor(code), 'Numeric');
  qr.make();
  return qr;
}

/**
 * 把矩阵画到 2D context 上。
 *
 * ★ margin 是**静默区**（二维码四周的空白边）。没有它或太窄，扫码识别率会明显下降 ——
 *   标准要求 4 个模块，这里按标准来。
 * ★ 每个格子用 floor/ceil 取整，宁可让相邻方块重叠一像素，也不留抗锯齿缝隙：
 *   缝隙会让扫描器把两个黑块读成三个。
 */
export function drawQr(ctx, qr, { size, margin = 4 } = {}) {
  const count = qr.getModuleCount();
  const cell = size / (count + margin * 2);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = '#000000';
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (!qr.isDark(r, c)) continue;
      const x = Math.floor((c + margin) * cell);
      const y = Math.floor((r + margin) * cell);
      ctx.fillRect(x, y, Math.ceil((c + margin + 1) * cell) - x, Math.ceil((r + margin + 1) * cell) - y);
    }
  }

  return { cell, count };
}
