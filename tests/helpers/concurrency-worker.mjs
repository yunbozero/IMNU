/**
 * 并发测试用的 worker。
 *
 * 在独立线程里打开同一个 SQLite 文件并反复操作，用来制造真实的并发写入。
 * 用真线程而不是"假装并发"，是因为防超卖这件事只有真的同时抢才算数。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../server/db.mjs';
import { createSqliteRepository } from '../../server/repository.mjs';

const { dbPath, mode, eventId, itemId, reservationId, code, attempts, workerIndex } = workerData;

const db = openDatabase(dbPath);
const repo = createSqliteRepository(db);

let ok = 0;
let failed = 0;
const reasons = {};

const bump = (reason) => { reasons[reason] = (reasons[reason] || 0) + 1; };

if (mode === 'reserve') {
  // 每次尝试都用不同的用户，避免撞上「一人一件」的重复预定规则，
  // 这样所有尝试都是冲着名额去的，才测得出超卖。
  for (let i = 0; i < attempts; i++) {
    const u = repo.createUser({
      openid: `w${workerIndex}-u${i}`,
      sid: `W${workerIndex}${String(i).padStart(3, '0')}`,
      name: `同学${workerIndex}-${i}`,
    });
    if (!u.ok) { failed++; bump('user_' + u.reason); continue; }

    const r = repo.tryReserve({
      eventId, itemId, userId: u.user.id, qty: 1,
      requestId: `w${workerIndex}-req-${i}`,
      code: `${workerIndex + 1}${String(i).padStart(3, '0')}01`,
    });

    if (r.ok) ok++;
    else { failed++; bump(r.reason); }
  }
} else if (mode === 'cancel') {
  // 所有线程抢着取消同一笔预定，只允许一个成功
  for (let i = 0; i < attempts; i++) {
    const r = repo.cancelReservation(reservationId);
    if (r.ok) ok++;
    else { failed++; bump(r.reason); }
  }
} else if (mode === 'redeem') {
  // 所有线程抢着核销同一个取货码，只允许一个成功
  for (let i = 0; i < attempts; i++) {
    const r = repo.redeem(eventId, code, `vol-${workerIndex}`);
    if (r.ok) ok++;
    else { failed++; bump(r.reason); }
  }
}

db.close();
parentPort.postMessage({ ok, failed, reasons });
