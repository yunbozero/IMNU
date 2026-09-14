/**
 * 备份 / 校验 / 恢复的测试。
 *
 * 这里最要紧的一条是「证明 `cp` 会丢数据」——因为那是所有人下意识的
 * 第一反应，而且它坏得很安静：文件看起来好好的，就是少东西。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import {
  REQUIRED_TABLES, backupDatabase, inspectBackup, listBackups,
  pruneBackups, restoreBackup, timestampName,
} from '../server/backup.mjs';

function tmpDir(tag = 'backup') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `imnu-${tag}-`));
}

/** 建一个带若干真实数据的库 */
function seededDb(file, { users = 3 } = {}) {
  const db = openMigrated(file);
  const repo = createSqliteRepository(db);
  const ev = repo.createEvent({ name: '义卖', status: 'on_sale' });
  const item = repo.createItem({ eventId: ev.id, name: '手作曲奇', totalQuota: 20 });

  for (let i = 0; i < users; i++) {
    const u = repo.createUser({ openid: `o${i}`, sid: `2021000${i}`, name: `同学${i}` }).user;
    repo.tryReserve({
      eventId: ev.id, itemId: item.id, userId: u.id, qty: 1,
      requestId: `r${i}`, code: String(100000 + i),
    });
  }
  return { db, repo, ev, item };
}

/* ============================================================
   ★ 为什么不能直接 cp
   ============================================================ */

test('备份：服务运行中直接 cp .db 会丢数据（所以必须用 VACUUM INTO）', () => {
  const dir = tmpDir('naive');
  const src = path.join(dir, 'bazaar.db');
  const naive = path.join(dir, 'naive-copy.db');

  try {
    // 先建库并写入一批数据，然后关掉（这一步会 checkpoint）
    const first = seededDb(src, { users: 1 });
    first.db.close();

    // 服务重新起来，再写一批 —— 这批会待在 -wal 里
    const live = new DatabaseSync(src);
    live.exec('PRAGMA journal_mode = WAL');
    live.exec('PRAGMA busy_timeout = 5000');
    live.exec("INSERT INTO users (id,openid,sid,name,role,created_at) " +
              "VALUES ('u_late','o_late','20219999','后来的','student',1)");
    assert.ok(fs.existsSync(src + '-wal'), '应当有 -wal 文件，否则这个测试证明不了什么');

    // ★ 这就是大家下意识的做法：趁服务在跑，把 .db 拷走
    fs.copyFileSync(src, naive);

    // 打开这份"朴实拷贝"，看后来那条记录在不在
    let sawLate = null;
    try {
      const copy = new DatabaseSync(naive, { readOnly: true });
      const row = copy.prepare("SELECT COUNT(*) AS c FROM users WHERE openid = 'o_late'").get();
      sawLate = row.c;
      copy.close();
    } catch {
      sawLate = '打不开';   // 拷贝到一半的文件也有可能是坏的，同样算失败
    }

    assert.notEqual(sawLate, 1,
      '朴实拷贝居然拿到了最新数据 —— 那这个测试就失去意义了，检查 WAL 是否被提前 checkpoint');

    // 对照：VACUUM INTO 出来的备份一定包含最新数据
    const good = path.join(dir, timestampName());
    backupDatabase(live, good);
    live.close();

    const info = inspectBackup(good);
    assert.equal(info.ok, true, 'VACUUM INTO 的备份应当通过校验');

    const check = new DatabaseSync(good, { readOnly: true });
    const cnt = check.prepare("SELECT COUNT(*) AS c FROM users WHERE openid = 'o_late'").get().c;
    check.close();
    assert.equal(cnt, 1, 'VACUUM INTO 的备份必须包含 -wal 里的最新数据');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ============================================================
   备份与校验
   ============================================================ */

test('备份：能产出通过校验的单文件备份', () => {
  const dir = tmpDir();
  try {
    const dbFile = path.join(dir, 'bazaar.db');
    const { db } = seededDb(dbFile, { users: 4 });

    const out = path.join(dir, 'backups', timestampName());
    const r = backupDatabase(db, out);
    db.close();

    assert.ok(r.bytes > 0);
    assert.ok(fs.existsSync(out));
    // 备份必须是自洽的单文件，不带 -wal / -shm
    assert.equal(fs.existsSync(out + '-wal'), false, '备份不应依赖 -wal');
    assert.equal(fs.existsSync(out + '-shm'), false, '备份不应依赖 -shm');

    const info = inspectBackup(out);
    assert.equal(info.ok, true);
    assert.equal(info.integrityOk, true);
    assert.deepEqual(info.missing, []);
    assert.equal(info.counts.users, 4);
    assert.equal(info.counts.reservations, 4);
    assert.equal(info.counts.events, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('备份：不覆盖已存在的文件（避免把好备份盖坏）', () => {
  const dir = tmpDir();
  try {
    const { db } = seededDb(path.join(dir, 'bazaar.db'));
    const out = path.join(dir, 'fixed.db');
    backupDatabase(db, out);
    assert.throws(() => backupDatabase(db, out), /已存在/);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('校验：文件不存在 / 不是数据库 / 缺表，都要判定为不可用', () => {
  const dir = tmpDir();
  try {
    const missing = inspectBackup(path.join(dir, 'nope.db'));
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'not_found');

    // 一个不是 SQLite 的文件
    const junk = path.join(dir, 'junk.db');
    fs.writeFileSync(junk, 'this is not a database at all');
    const bad = inspectBackup(junk);
    assert.equal(bad.ok, false, '垃圾文件必须被判为不可用');

    // 是合法 SQLite，但缺表
    const thin = path.join(dir, 'thin.db');
    const t = new DatabaseSync(thin);
    t.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    t.close();
    const thinInfo = inspectBackup(thin);
    assert.equal(thinInfo.ok, false, '缺表的库不能算合格备份');
    assert.ok(thinInfo.missing.includes('reservations'));
    assert.equal(thinInfo.missing.length, REQUIRED_TABLES.length - 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ============================================================
   轮转
   ============================================================ */

test('备份：按数量轮转，只保留最新的 N 份', () => {
  const dir = tmpDir();
  const backups = path.join(dir, 'backups');
  try {
    fs.mkdirSync(backups, { recursive: true });

    // 造 5 份名字可排序的备份
    const names = [
      'bazaar-20260101-000000.db',
      'bazaar-20260102-000000.db',
      'bazaar-20260103-000000.db',
      'bazaar-20260104-000000.db',
      'bazaar-20260105-000000.db',
    ];
    for (const n of names) fs.writeFileSync(path.join(backups, n), 'x');

    // 顺带放一个不相干的文件，轮转不该碰它
    fs.writeFileSync(path.join(backups, 'README.txt'), 'keep me');

    const listed = listBackups(backups).map((b) => b.name);
    assert.equal(listed[0], 'bazaar-20260105-000000.db', '最新的应当排在最前');
    assert.equal(listed.length, 5);

    const removed = pruneBackups(backups, 2);
    assert.equal(removed.length, 3);
    assert.deepEqual(listBackups(backups).map((b) => b.name), [
      'bazaar-20260105-000000.db',
      'bazaar-20260104-000000.db',
    ]);
    assert.ok(fs.existsSync(path.join(backups, 'README.txt')), '不该删掉无关文件');

    assert.throws(() => pruneBackups(backups, 0), /keep/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ============================================================
   ★ 恢复（唯一一个做错了就真丢数据的操作）
   ============================================================ */

test('恢复：备份 → 数据损坏 → 恢复，数据要完整回来', () => {
  const dir = tmpDir();
  const dbFile = path.join(dir, 'bazaar.db');
  try {
    // 1. 有一批数据
    const { db, ev, item } = seededDb(dbFile, { users: 5 });
    const out = path.join(dir, timestampName());
    backupDatabase(db, out);
    db.close();

    // 2. 出事：误删了一批预定
    const broken = openMigrated(dbFile);
    broken.exec('DELETE FROM reservations');
    assert.equal(broken.prepare('SELECT COUNT(*) AS c FROM reservations').get().c, 0);
    broken.close();

    // 3. 从备份恢复
    const r = restoreBackup(out, dbFile);
    assert.equal(r.ok, true);
    assert.equal(r.counts.users, 5);
    assert.equal(r.counts.reservations, 5);
    assert.ok(r.safetyCopy && fs.existsSync(r.safetyCopy), '应当把出事的库留底而不是直接删掉');

    // 4. 恢复后的库能正常用，而且名额账目是对的
    const restored = openMigrated(dbFile);
    const repo = createSqliteRepository(restored);
    const it = repo.getItem(item.id);
    const held = restored.prepare(
      "SELECT COALESCE(SUM(qty),0) AS s FROM reservations WHERE item_id=? AND status IN ('reserved','redeemed')"
    ).get(item.id).s;
    assert.equal(it.remainingQuota + held, it.totalQuota, '恢复后账目必须还是平的');
    assert.equal(it.remainingQuota, 20 - 5);
    void ev;
    restored.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('恢复：必须清掉旧库的 -wal / -shm，否则会把新库带坏', () => {
  const dir = tmpDir();
  const dbFile = path.join(dir, 'bazaar.db');
  try {
    const { db } = seededDb(dbFile, { users: 2 });
    const out = path.join(dir, timestampName());
    backupDatabase(db, out);
    db.close();

    // 制造出 -wal / -shm
    const live = openMigrated(dbFile);
    live.exec("INSERT INTO users (id,openid,sid,name,role,created_at) " +
              "VALUES ('u_x','o_x','20218888','临时','student',1)");
    live.close();

    fs.writeFileSync(dbFile + '-wal', 'stale wal content');
    fs.writeFileSync(dbFile + '-shm', 'stale shm content');

    restoreBackup(out, dbFile);

    assert.equal(fs.existsSync(dbFile + '-wal'), false, '旧 WAL 必须删掉');
    assert.equal(fs.existsSync(dbFile + '-shm'), false, '旧 SHM 必须删掉');

    const check = openMigrated(dbFile);
    const cnt = check.prepare("SELECT COUNT(*) AS c FROM users WHERE openid='o_x'").get().c;
    assert.equal(cnt, 0, '恢复后不该还有那条临时数据');
    check.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('恢复：备份不合格就直接拒绝，绝不动线上库', () => {
  const dir = tmpDir();
  const dbFile = path.join(dir, 'bazaar.db');
  try {
    const { db } = seededDb(dbFile, { users: 3 });
    db.close();

    const before = fs.readFileSync(dbFile);

    const junk = path.join(dir, 'junk.db');
    fs.writeFileSync(junk, 'not a database');

    assert.throws(() => restoreBackup(junk, dbFile), /未通过校验/);

    const after = fs.readFileSync(dbFile);
    assert.ok(before.equals(after), '拒绝恢复时线上库必须原封不动');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('恢复：不存在的备份文件也要拒绝', () => {
  const dir = tmpDir();
  try {
    assert.throws(
      () => restoreBackup(path.join(dir, 'nope.db'), path.join(dir, 'bazaar.db')),
      /未通过校验/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('备份：文件名的日期部分可排序，轮转才靠得住', () => {
  const a = timestampName(new Date('2026-09-14T09:05:03'));
  const b = timestampName(new Date('2026-09-14T21:30:00'));
  assert.equal(a, 'bazaar-20260914-090503.db');
  assert.ok(a < b, '文件名必须可以按字典序排出时间先后');
});
