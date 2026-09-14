/**
 * 把 repository 契约测试跑在 SQLite 实现上。
 * 将来云开发版实现写好后，照抄一份换掉 makeRepo 即可。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRepositoryContract } from './repository-contract.mjs';
import { openMigrated, SCHEMA } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';

describeRepositoryContract('SQLite', () => {
  const db = openMigrated(':memory:');
  return {
    repo: createSqliteRepository(db),
    cleanup: () => db.close(),
  };
});

/* ============================================================
   合规：后端同样不许出现金额字段
   ============================================================ */

test('合规：数据库 schema 里不存在任何金额相关字段', () => {
  assert.ok(SCHEMA.includes('remaining_quota'), 'schema 读取异常，检查没意义');

  // 只扫真实的 DDL，不扫注释。
  // 注释里写"不含任何金额字段"是正常的说明，不该被当成违规。
  const ddl = SCHEMA.replace(/--[^\n]*/g, '');

  const banned = /\b(price|amount|money|cost|fee|payment|paid|discount|refund)\w*/i;
  const found = ddl.match(banned);
  assert.equal(found, null, `schema 里出现了疑似金额字段：${found && found[0]}`);

  const cnBanned = /(\d+\s*元|[价價]格|金额)/;
  const cnFound = ddl.match(cnBanned);
  assert.equal(cnFound, null, `schema 里出现了金额字样：${cnFound && cnFound[0]}`);

  // 反向确认：真的扫到了表定义，不是把整个 schema 过滤空了
  assert.ok(/CREATE TABLE/i.test(ddl), 'strip 注释后应当还能看到建表语句');
});

test('合规：repository 的返回值里不带金额字段', () => {
  const db = openMigrated(':memory:');
  try {
    const repo = createSqliteRepository(db);
    const ev = repo.createEvent({ name: 'x', status: 'on_sale' });
    const item = repo.createItem({ eventId: ev.id, name: '手作曲奇', totalQuota: 5 });
    const u = repo.createUser({ openid: 'o1', sid: '20210001', name: '甲' }).user;

    const keys = new Set([
      ...Object.keys(item),
      ...Object.keys(u),
      ...Object.keys(ev),
    ]);
    for (const k of keys) {
      assert.ok(!/price|amount|money|cost|fee|payment/i.test(k),
        `返回值里出现了疑似金额字段：${k}`);
    }
  } finally {
    db.close();
  }
});
