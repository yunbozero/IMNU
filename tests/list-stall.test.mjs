/**
 * 名单按摊位筛选。
 *
 * 义卖当天每个摊位守自己那摊：如果名单是「全场几十行」，摊主得在别人的记录里
 * 一行行找自己那几件。摊位名必须跟着每一行返回（服务端 join 好），
 * 客户端只做本地过滤 —— 名单就几百条，比每敲一次发一次请求快。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(p, 'utf8');

function fixture() {
  const db = openMigrated(':memory:');
  const repo = createSqliteRepository(db);

  const event = repo.createEvent({
    name: '春季义卖', startsAt: Date.now() + 3600_000, endsAt: Date.now() + 7200_000, status: 'open',
  });
  const stall = repo.createStall({ eventId: event.id, name: '手作摊', loc: '图书馆前' });
  const item = repo.createItem({
    eventId: event.id, stallId: stall.id, name: '手作书签', emoji: '🔖', totalQuota: 5,
  });
  const loose = repo.createItem({
    eventId: event.id, name: '无摊位的旧物', emoji: '📦', totalQuota: 5,
  });

  const user = repo.createUser({ openid: 'op-a', name: '同学甲' }).user;
  repo.tryReserve({
    eventId: event.id, itemId: item.id, userId: user.id, qty: 1, code: '482913', requestId: 'r1',
  });
  repo.tryReserve({
    eventId: event.id, itemId: loose.id, userId: user.id, qty: 1, code: '482914', requestId: 'r2',
  });

  return { db, repo, event, close: () => db.close() };
}

test('名单：每一行都带摊位名（没挂摊位的为 null）', () => {
  const f = fixture();
  try {
    const rows = f.repo.listEventReservations(f.event.id);
    assert.equal(rows.length, 2);

    const withStall = rows.find((r) => r.itemName === '手作书签');
    assert.equal(withStall.stallName, '手作摊');
    assert.ok(withStall.stallId);

    const noStall = rows.find((r) => r.itemName === '无摊位的旧物');
    assert.equal(noStall.stallName, null, '没挂摊位就是 null，界面自己决定怎么显示');
    assert.equal(noStall.stallId, null);
  } finally { f.close(); }
});

test('名单页：有摊位筛选条，且是本地过滤', () => {
  const js = read(path.join(MP, 'packageAdmin/pages/reservations/index.js'));
  assert.match(js, /stallName/, '每行要保留摊位名');
  assert.match(js, /onStallTap/, '要有切换摊位的处理函数');
  assert.match(js, /__none__/, '「未分摊位」要单独一档 —— 筛了就消失会漏人');
  assert.doesNotMatch(js, /stall.*api\.get|api\.get.*stall/, '筛选不许发请求，本地过滤');

  const wxml = read(path.join(MP, 'packageAdmin/pages/reservations/index.wxml'));
  assert.match(wxml, /wx:for="\{\{stalls\}\}"/, '要画摊位筛选条');
  assert.match(wxml, /bindtap="onStallTap"/);
  // 单摊位活动不该多一行纯噪音
  assert.match(wxml, /wx:if="\{\{stalls\.length\}\}"/, '只有一个摊位时不显示筛选条');
});
