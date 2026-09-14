/**
 * 真实多线程并发测试。
 *
 * 这里是整个项目最该被证明的一件事：不管多少人同时抢，
 * 名额都不会超卖，取消也不会让名额虚增，同一个取货码只能核销一次。
 *
 * 用 worker_threads 开多个线程，各自打开同一个 SQLite 文件并发写——
 * 不是"顺序调用假装并发"，是真的同时在抢。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';

const WORKER_URL = new URL('./helpers/concurrency-worker.mjs', import.meta.url);

const WORKERS = 8;
const ATTEMPTS = 15;              // 每个线程尝试次数
const TOTAL_ATTEMPTS = WORKERS * ATTEMPTS;

/** 建一个临时库，返回路径与关键 id */
function makeFixture(quota) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-quota-'));
  const dbPath = path.join(dir, 'bazaar.db');

  const db = openMigrated(dbPath);
  const repo = createSqliteRepository(db);
  const ev = repo.createEvent({ name: '并发测试场次', status: 'on_sale' });
  const stall = repo.createStall({ eventId: ev.id, name: '一号摊位', loc: '图书馆前' });
  const item = repo.createItem({
    eventId: ev.id, stallId: stall.id, name: '限量手作曲奇', totalQuota: quota,
  });
  db.close();                     // 关掉，把文件让给 worker

  return {
    dbPath,
    eventId: ev.id,
    itemId: item.id,
    // Windows 上 worker 退出后文件句柄可能还要一小会儿才释放，删不掉就忽略
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    },
  };
}

/** 并发跑一批 worker，等全部「退出」再返回（不能只听 message，否则文件还被占着） */
function runWorkers(dbPath, workerData, count = WORKERS) {
  const runs = [];
  for (let w = 0; w < count; w++) {
    runs.push(new Promise((resolve, reject) => {
      let result;
      const worker = new Worker(WORKER_URL, {
        workerData: { dbPath, workerIndex: w, ...workerData },
      });
      worker.once('message', (m) => { result = m; });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0 || !result) reject(new Error(`worker 异常退出，exit code = ${code}`));
        else resolve(result);
      });
    }));
  }
  return Promise.all(runs);
}

const sum = (arr, key) => arr.reduce((n, r) => n + (r[key] || 0), 0);

/* ============================================================
   1. 抢名额
   ============================================================ */

test(`并发抢名额：${WORKERS} 线程 × ${ATTEMPTS} 次抢 ${20} 份，恰好卖出 20 份`, async () => {
  const QUOTA = 20;
  const fx = makeFixture(QUOTA);

  try {
    const results = await runWorkers(fx.dbPath, {
      mode: 'reserve', eventId: fx.eventId, itemId: fx.itemId, attempts: ATTEMPTS,
    });

    const ok = sum(results, 'ok');
    const failed = sum(results, 'failed');

    assert.equal(ok, QUOTA, `应当恰好成功 ${QUOTA} 次，实际 ${ok} 次（超卖或少卖都算错）`);
    assert.equal(ok + failed, TOTAL_ATTEMPTS, '每次尝试都要有明确结果');
    assert.equal(failed, TOTAL_ATTEMPTS - QUOTA);

    // 失败的原因必须全是"约满"，不能出现别的异常
    const reasons = {};
    for (const r of results) {
      for (const [k, v] of Object.entries(r.reasons || {})) reasons[k] = (reasons[k] || 0) + v;
    }
    assert.deepEqual(Object.keys(reasons), ['soldout'],
      `失败原因应当只有 soldout，实际：${JSON.stringify(reasons)}`);

    // 落库数据复核
    const db = openMigrated(fx.dbPath);
    const repo = createSqliteRepository(db);
    const item = repo.getItem(fx.itemId);

    assert.equal(item.remainingQuota, 0, '剩余名额必须归零');
    assert.ok(item.remainingQuota >= 0, '名额绝不能为负');

    const reserved = db.prepare(
      `SELECT COUNT(*) AS c FROM reservations WHERE item_id = ? AND status = 'reserved'`
    ).get(fx.itemId).c;
    assert.equal(reserved, QUOTA, `数据库里应当有 ${QUOTA} 笔待取货预定`);

    const qtySum = db.prepare(
      `SELECT COALESCE(SUM(qty),0) AS s FROM reservations WHERE item_id = ? AND status = 'reserved'`
    ).get(fx.itemId).s;
    assert.equal(qtySum, QUOTA, '已预定数量之和必须等于总数');

    db.close();
  } finally {
    fx.cleanup();
  }
});

/* ============================================================
   2. 抢着取消同一笔预定
   ============================================================ */

test(`并发取消同一笔预定：${WORKERS} 线程抢，只有 1 次成功，名额只释放一次`, async () => {
  const QUOTA = 5;
  const fx = makeFixture(QUOTA);

  try {
    // 先正常预定一笔
    const db0 = openMigrated(fx.dbPath);
    const repo0 = createSqliteRepository(db0);
    const u = repo0.createUser({ openid: 'u1', sid: '20210001', name: '甲' }).user;
    const r = repo0.tryReserve({
      eventId: fx.eventId, itemId: fx.itemId, userId: u.id, qty: 2,
      requestId: 'seed', code: '123456',
    });
    assert.equal(r.ok, true);
    assert.equal(repo0.getItem(fx.itemId).remainingQuota, 3);
    db0.close();

    const results = await runWorkers(fx.dbPath, {
      mode: 'cancel', reservationId: r.reservation.id, attempts: 3,
    });

    assert.equal(sum(results, 'ok'), 1, '同一个预定只能被成功取消一次');

    const db = openMigrated(fx.dbPath);
    const repo = createSqliteRepository(db);
    const remaining = repo.getItem(fx.itemId).remainingQuota;

    assert.equal(remaining, QUOTA, `名额必须精确恢复到 ${QUOTA}，实际 ${remaining}（虚增就是 bug）`);
    assert.equal(repo.getReservation(r.reservation.id).status, 'cancelled');
    db.close();
  } finally {
    fx.cleanup();
  }
});

/* ============================================================
   3. 抢着核销同一个取货码
   ============================================================ */

test(`并发核销同一个码：${WORKERS} 线程抢，只有 1 次成功`, async () => {
  const fx = makeFixture(5);
  const CODE = '482913';

  try {
    const db0 = openMigrated(fx.dbPath);
    const repo0 = createSqliteRepository(db0);
    const u = repo0.createUser({ openid: 'u1', sid: '20210001', name: '甲' }).user;
    const r = repo0.tryReserve({
      eventId: fx.eventId, itemId: fx.itemId, userId: u.id, qty: 1,
      requestId: 'seed', code: CODE,
    });
    assert.equal(r.ok, true);
    db0.close();

    const results = await runWorkers(fx.dbPath, {
      mode: 'redeem', eventId: fx.eventId, code: CODE, attempts: 3,
    });

    assert.equal(sum(results, 'ok'), 1, '同一个取货码只能被成功核销一次');

    const db = openMigrated(fx.dbPath);
    const repo = createSqliteRepository(db);
    const res = repo.getReservation(r.reservation.id);

    assert.equal(res.status, 'redeemed');
    assert.ok(res.redeemedAt, '必须记录核销时间');
    assert.ok(res.operatorId, '必须记录经手的志愿者');
    db.close();
  } finally {
    fx.cleanup();
  }
});

/* ============================================================
   4. 数据库层的兜底防线
   ============================================================ */

test('就算绕过应用层直接写 SQL，数据库也会拒绝把名额扣成负数', () => {
  const fx = makeFixture(1);

  try {
    const db = openMigrated(fx.dbPath);
    // 应用层之外的第二道防线：CHECK (remaining_quota >= 0)
    assert.throws(() => {
      db.prepare('UPDATE items SET remaining_quota = remaining_quota - 5 WHERE id = ?')
        .run(fx.itemId);
    }, /CHECK|constraint/i, 'CHECK 约束必须拦住负数');

    db.close();
  } finally {
    fx.cleanup();
  }
});
