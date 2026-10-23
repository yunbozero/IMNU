/**
 * 导出的 CSV 里时间必须是**北京时间**。
 *
 * 曾经踩过：`fmtTime` 用 `getHours()`（服务器本地时区）渲染，
 * 部署机是 UTC 时，打印出来的纸质兜底名单上「预定/核销时间」整整齐齐差 8 小时，
 * 而本地开发机多半在东八区 —— **本地怎么测都是对的**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCsv, CSV_HEADER } from '../server/api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = fs.readFileSync(path.join(ROOT, 'server', 'api.mjs'), 'utf8');

/** 独立算一遍北京时间，别复用被测代码 */
const beijing = (ts) => new Date(Number(ts) + 8 * 60 * 60 * 1000)
  .toISOString().slice(0, 16).replace('T', ' ');

test('CSV：预定 / 核销时间按北京时间渲染', () => {
  // 2026-04-18 01:00 UTC = 北京时间 09:00；跨日边界也验一下
  const created = Date.UTC(2026, 3, 17, 23, 30);      // 北京 04-18 07:30
  const redeemed = Date.UTC(2026, 3, 18, 1, 0);        // 北京 04-18 09:00

  const csv = toCsv([{
    code: '482913', itemName: '手作书签', qty: 1,
    userName: '同学甲', userSid: null, status: 'redeemed',
    createdAt: created, redeemedAt: redeemed,
  }]);

  assert.ok(csv.includes(beijing(created)), `CSV 里没有北京时间 ${beijing(created)}`);
  assert.ok(csv.includes(beijing(redeemed)), `CSV 里没有北京时间 ${beijing(redeemed)}`);
  assert.ok(csv.includes('2026-04-18 09:00'), 'UTC 01:00 应显示成北京 09:00');
  assert.ok(csv.includes('2026-04-18 07:30'), 'UTC 前一天 23:30 应显示成北京次日 07:30');

  // 表头不能被顺手改掉：这份文件是拿去打印的
  assert.equal(csv.split('\r\n')[0].replace(/^\uFEFF/, ''), CSV_HEADER.join(','));
});

test('CSV：源码里不许再出现用本地时区的 fmtTime', () => {
  // 上面那条用例在 +08 的机器上分辨不出「本地时区」和「北京时间」——
  // 所以再加一条代码级守卫，保证没人把 fmtTime 写回来。
  assert.doesNotMatch(API, /function fmtTime/, 'fmtTime 用 getHours()，会把 UTC 服务器的时间渲染错');
  assert.match(API, /formatEventTime\(r\.createdAt\)/, 'CSV 的时间要走 formatEventTime（北京时间）');
});
