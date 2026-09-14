/**
 * 不变量（invariant）性质测试。
 *
 * 前面那些测试是「给定输入，期望某个输出」，覆盖的是我想得到的场景。
 * 这里换一种思路：随机执行几百步操作，**每一步之后**都断言账目必须平衡。
 * 想漏掉的 bug，这种测试往往能自己撞出来。
 *
 * 核心不变量：
 *   remaining_quota + Σ(qty of reserved/redeemed) == total_quota
 *
 * 直觉解释：预定扣名额，取消还名额，核销不动名额。
 * 所以「还剩的」加上「已经被占住的（含已领走的）」必须永远等于总数。
 * 只要哪一步多扣了、少还了、或者取消两次导致虚增，这个等式立刻就破。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';

/** 确定性伪随机，保证失败可复现 */
function makeRandom(seed = 20260914) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
}

function assertBalanced(t, { db, repo, items, step }) {
  for (const it of items) {
    const row = repo.getItem(it.id);

    assert.ok(row.remainingQuota >= 0,
      `第 ${step} 步后「${it.name}」名额变成负数：${row.remainingQuota}`);

    const held = db.prepare(`
      SELECT COALESCE(SUM(qty), 0) AS s
        FROM reservations
       WHERE item_id = ? AND status IN ('reserved', 'redeemed')
    `).get(it.id).s;

    assert.equal(row.remainingQuota + held, row.totalQuota,
      `第 ${step} 步后「${it.name}」账目不平：还剩 ${row.remainingQuota} + 已占 ${held} != 总数 ${row.totalQuota}`);
  }
}

test('随机 400 步操作后，每件物品的名额账目始终平衡', () => {
  const db = openMigrated(':memory:');
  const repo = createSqliteRepository(db);
  const rnd = makeRandom();

  try {
    const ev = repo.createEvent({ name: '不变量测试', status: 'on_sale' });

    // 造几件名额不同的物品，其中一件只有 1 个名额，专门制造"抢最后一件"
    const items = [
      repo.createItem({ eventId: ev.id, name: '限量曲奇', totalQuota: 6 }),
      repo.createItem({ eventId: ev.id, name: '多肉盆栽', totalQuota: 20 }),
      repo.createItem({ eventId: ev.id, name: '孤品尤克里里', totalQuota: 1 }),
    ];

    // 用户要足够多。只有 4 个用户的话，(用户 × 物品) 的活跃组合很快被占满，
    // 之后的预定尝试全部撞在「一人一件」上，随机游走就跑不动了。
    const users = Array.from({ length: 12 }, (_, i) => repo.createUser({
      openid: `o${i}`, sid: `202100${String(i).padStart(2, '0')}`, name: `同学${i}`,
    }).user);

    // 统计各分支被走到的次数——这比"记录条数"更能说明测试不是空跑
    const hits = {
      restock: 0, reserveOk: 0, soldout: 0, dup: 0, codeTaken: 0,
      cancelOk: 0, cancelFail: 0, redeemOk: 0, redeemFail: 0,
    };

    let seq = 0;
    const nextCode = () => String(100000 + seq++ % 900000);

    for (let step = 1; step <= 400; step++) {
      const dice = rnd();

      if (dice < 0.10) {
        /* ---- 补货：总数与剩余同步增加，不变量必须继续成立 ----
           加这个动作是为了让随机游走不会因为"全抢光了"而卡死，
           顺便也验证了管理员改名额时账目不会失衡。
           刻意不动那件只有 1 个名额的孤品，这样 soldout 分支才会被走到。 */
        const it = items[Math.floor(rnd() * (items.length - 1))];
        const add = 1 + Math.floor(rnd() * 5);
        db.prepare(`UPDATE items
                       SET total_quota = total_quota + ?, remaining_quota = remaining_quota + ?
                     WHERE id = ?`).run(add, add, it.id);
        hits.restock++;
      } else if (dice < 0.60) {
        /* ---- 预定 ---- */
        const it = items[Math.floor(rnd() * items.length)];
        const u = users[Math.floor(rnd() * users.length)];
        const qty = 1 + Math.floor(rnd() * 2);

        const r = repo.tryReserve({
          eventId: ev.id, itemId: it.id, userId: u.id, qty,
          requestId: `req-${step}`, code: nextCode(),
        });
        if (r.ok) hits.reserveOk++;
        else if (r.reason === 'dup') hits.dup++;
        else if (r.reason === 'soldout') hits.soldout++;
        else if (r.reason === 'code_taken') hits.codeTaken++;
        else throw new Error(`意外失败原因：${r.reason}`);
      } else if (dice < 0.85) {
        /* ---- 取消一笔待取货的预定 ---- */
        const active = db.prepare(`
          SELECT id FROM reservations WHERE status = 'reserved'
           ORDER BY RANDOM() LIMIT 1
        `).get();
        if (active) {
          const r = repo.cancelReservation(active.id);
          if (r.ok) hits.cancelOk++; else hits.cancelFail++;
        }
      } else {
        /* ---- 核销一笔待取货的预定 ---- */
        const active = db.prepare(`
          SELECT id, code, event_id FROM reservations WHERE status = 'reserved'
           ORDER BY RANDOM() LIMIT 1
        `).get();
        if (active) {
          const r = repo.redeem(active.event_id, active.code, 'vol-1');
          if (r.ok) hits.redeemOk++; else hits.redeemFail++;
        }
      }

      // ★ 每一步之后都必须平衡
      assertBalanced(null, { db, repo, items, step });
    }

    console.log('  分支覆盖：', JSON.stringify(hits));

    // 这个测试的价值在于"覆盖够广 + 账目从没失衡"。
    // 如果某个分支一次都没走到，说明序列没测到那条路径，测试是虚的。
    for (const branch of ['reserveOk', 'soldout', 'dup', 'cancelOk', 'redeemOk']) {
      assert.ok(hits[branch] > 0, `分支 ${branch} 一次都没走到，这个性质测试没测全`);
    }
    assert.ok(hits.reserveOk >= 30, `预定成功次数太少（${hits.reserveOk}），随机游走不够充分`);

    const stats = db.prepare(`
      SELECT status, COUNT(*) AS c FROM reservations GROUP BY status
    `).all();
    const byStatus = Object.fromEntries(stats.map((r) => [r.status, r.c]));
    assert.ok(byStatus.reserved > 0, '应当还有待取货的记录');
    assert.ok(byStatus.redeemed > 0, '应当有已核销的记录');
    assert.ok(byStatus.cancelled > 0, '应当有已取消的记录');

    console.log('  落库状态：', JSON.stringify(byStatus));
  } finally {
    db.close();
  }
});

test('重复预定不会让账目失衡（同一人反复点同一件）', () => {
  const db = openMigrated(':memory:');
  const repo = createSqliteRepository(db);

  try {
    const ev = repo.createEvent({ name: 'x', status: 'on_sale' });
    const item = repo.createItem({ eventId: ev.id, name: '曲奇', totalQuota: 5 });
    const u = repo.createUser({ openid: 'o1', sid: '20210001', name: '甲' }).user;

    // 同一个人连着点 10 次，每次都换 requestId（模拟学生手抖 + 重试）
    let okCount = 0;
    for (let i = 0; i < 10; i++) {
      const r = repo.tryReserve({
        eventId: ev.id, itemId: item.id, userId: u.id, qty: 1,
        requestId: `burst-${i}`, code: String(200000 + i),
      });
      if (r.ok) okCount++;
    }

    assert.equal(okCount, 1, '十次点击只应该成功一次');
    assert.equal(repo.getItem(item.id).remainingQuota, 4, '只能扣掉一个名额');
    assertBalanced(null, { db, repo, items: [item], step: 'burst' });
  } finally {
    db.close();
  }
});
