/**
 * 活动时间的解析与显示（`server/time.mjs`）。
 *
 * 这个模块小，但它是**脚本和接口共用的那一份**：配置文件里的时间、
 * 以及「新建活动」接口收到的时间，都走它。两边各写一份的话，
 * 同一句「2026-04-18 09:00」会存成两个不同的时刻 ——
 * 而且只在线上、只在某一种入口下暴露。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEventTime, checkRange, formatEventTime } from '../server/time.mjs';

test('时间：按北京时间解析，不受运行环境的时区影响', () => {
  const ms = parseEventTime('2026-04-18 09:00', '开始时间');

  // toISOString 永远是 UTC，所以这条断言在任何时区的机器上都成立。
  // ★ 反过来说：如果实现改成 new Date('2026-04-18 09:00')（按本机时区解释），
  //   在 UTC 的云服务器上这里会得到 09:00Z，学生手机（+08:00）看到的是 17:00。
  assert.equal(new Date(ms).toISOString(), '2026-04-18T01:00:00.000Z',
    '09:00 北京时间 = 01:00 UTC，差 8 小时就是时区没处理对');

  // 带 T 的写法也认
  assert.equal(parseEventTime('2026-04-18T09:00', 'x'), ms);

  // 不填就是 null（这两个字段可以为空）
  for (const empty of [undefined, null, '']) {
    assert.equal(parseEventTime(empty, 'x'), null);
  }
});

test('时间：格式不对要说清楚是哪个字段', () => {
  const bad = [
    ['2026/04/18 09:00', /startsAt/],
    ['2026-04-18', /startsAt/],
    ['09:00', /startsAt/],
    ['2026-04-18 09:00:00', /startsAt/],
    [20260418090000, /字符串/],
  ];
  for (const [v, re] of bad) {
    assert.throws(() => parseEventTime(v, 'startsAt'), re,
      `「${v}」应当被拒，且报错要指明是哪个字段`);
  }
});

test('时间：★ 不存在的日期要拒掉，不能被悄悄往后滚', () => {
  // ★ V8 对 ISO 字符串里的越界日期是**往后滚动**而不是报错：
  //   Date.parse('2026-02-30T09:00:00+08:00') 会静悄悄变成 3 月 2 日。
  //   所以光靠 Date.parse + isFinite 拦不住，必须回头核对。
  assert.throws(() => parseEventTime('2026-02-30 09:00', 'x'), /真实的日期/);
  assert.throws(() => parseEventTime('2026-04-31 09:00', 'x'), /真实的日期/);
  assert.throws(() => parseEventTime('2026-13-01 09:00', 'x'), /真实的日期/);
  assert.throws(() => parseEventTime('2026-04-18 25:00', 'x'), /真实的日期/);
});

test('时间：结束早于开始要拒', () => {
  const s = parseEventTime('2026-04-18 09:00', 's');
  const e = parseEventTime('2026-04-18 17:00', 'e');

  assert.doesNotThrow(() => checkRange(s, e));
  assert.doesNotThrow(() => checkRange(null, e), '只填结束时间是允许的');
  assert.doesNotThrow(() => checkRange(s, null), '只填开始时间也是允许的');
  assert.throws(() => checkRange(e, s), /结束时间 比 开始时间 还早/);

  // 报错要用调用方给的字段名 —— 接口和脚本的字段名不一样
  assert.throws(() => checkRange(e, s, { start: 'event.startsAt', end: 'event.endsAt' }),
    /event\.endsAt/);
});

test('时间：能渲染回给人看的字符串（界面回显要用）', () => {
  const ms = parseEventTime('2026-04-18 09:00', 'x');
  assert.equal(formatEventTime(ms), '2026-04-18 09:00');

  // ★ 渲染也必须按北京时间。用本机时区渲染的话，
  //   在 UTC 服务器上会把 09:00 显示成 01:00 —— 界面和库对不上。
  assert.equal(formatEventTime(parseEventTime('2026-01-01 00:30', 'x')), '2026-01-01 00:30',
    '跨年、跨日边界也要对');

  // 没填就是空串（界面上不该出现 "Invalid Date" 或 "null"）
  for (const empty of [null, undefined, 0]) {
    assert.equal(formatEventTime(empty), '');
  }
});
