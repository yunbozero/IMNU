/**
 * 数据库备份 / 校验 / 恢复。
 *
 * 为什么不用 `cp bazaar.db`：
 *   数据库跑在 WAL 模式下，最近的写入可能还在 `-wal` 文件里没落盘。
 *   只拷 .db 一个文件，拷出来的很可能是缺数据的。
 *   tests/backup.test.mjs 里有一条测试专门证明这件事。
 *
 * 正确做法是 SQLite 的 `VACUUM INTO`：它会产出一个**自洽的、单文件的、
 * 已整理过**的副本，不需要额外拷 -wal / -shm。
 *
 * 用法：
 *   DB_PATH=... BACKUP_DIR=... node server/backup.mjs            # 备份 + 清理旧份
 *   node server/backup.mjs list                                  # 列出备份
 *   node server/backup.mjs verify <文件>                          # 校验某一份
 *   DB_PATH=... node server/backup.mjs restore <文件> --yes       # 恢复（危险操作）
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/** 备份文件必须有的表。少一张就说明这份备份不可用。 */
export const REQUIRED_TABLES = [
  'users', 'events', 'stalls', 'items', 'reservations', 'audit_logs',
];

export function timestampName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `bazaar-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
         `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`;
}

/** SQLite 字符串字面量里的单引号要写两遍 */
const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * 把当前数据库备份到 outFile。
 * @returns {{file: string, bytes: number}}
 */
export function backupDatabase(db, outFile) {
  if (fs.existsSync(outFile)) {
    throw new Error(`备份目标已存在，不覆盖：${outFile}`);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // VACUUM INTO 在 SQLite 3.27+ 可用；Node 24 内置的是 3.5x
  db.exec(`VACUUM INTO ${sqlStr(outFile)}`);

  return { file: outFile, bytes: fs.statSync(outFile).size };
}

/**
 * 打开一份备份做体检：能否打开、结构对不对、数据有没有坏、有多少行。
 * 备份不做校验，等于没有备份。
 */
export function inspectBackup(file) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'not_found', file };

  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });

    // ★ 注意：DatabaseSync 是惰性打开的。文件根本不是数据库时，
    //   构造函数不会报错，要等第一次查询才抛 "file is not a database"。
    //   所以整个读取过程都必须包在 try 里，不能只包构造函数。
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const integrityOk = Object.values(integrity)[0] === 'ok';

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);

    const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));

    const counts = {};
    for (const t of REQUIRED_TABLES) {
      if (tables.includes(t)) {
        counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      }
    }

    return {
      ok: integrityOk && missing.length === 0,
      file,
      bytes: fs.statSync(file).size,
      integrityOk,
      missing,
      counts,
    };
  } catch (e) {
    return { ok: false, reason: 'unreadable', file, message: e.message };
  } finally {
    try { if (db) db.close(); } catch { /* 打不开的库关不掉也无所谓 */ }
  }
}

/** 列出目录里的备份，新的在前 */
export function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^bazaar-\d{8}-\d{6}\.db$/.test(f))
    .sort()
    .reverse()
    .map((f) => {
      const full = path.join(dir, f);
      return { file: full, name: f, bytes: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs };
    });
}

/**
 * 只保留最新的 keep 份，其余删掉。
 * @returns {string[]} 被删掉的文件名
 */
export function pruneBackups(dir, keep) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep 必须是 >= 1 的整数');
  const removed = listBackups(dir).slice(keep).map((b) => b.name);
  for (const name of removed) fs.rmSync(path.join(dir, name), { force: true });
  return removed;
}

/**
 * 从备份恢复。
 *
 * 步骤刻意做得啰嗦，因为这是唯一一个「做错了就真丢数据」的操作：
 *   1. 先校验备份，不合格直接拒绝，绝不动线上库
 *   2. 把现有库改名留底，而不是直接删除
 *   3. 拷回来之后**必须删掉 -wal / -shm**
 *      —— 那是旧库的预写日志，留着会被误当成新库的日志去重放，直接把库搞坏
 *   4. 恢复后再校验一次
 */
export function restoreBackup(backupFile, dbPath) {
  const check = inspectBackup(backupFile);
  if (!check.ok) {
    throw new Error(`备份未通过校验，拒绝恢复：${JSON.stringify(check)}`);
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let moved = null;
  if (fs.existsSync(dbPath)) {
    moved = `${dbPath}.pre-restore-${Date.now()}`;
    fs.renameSync(dbPath, moved);
  }

  // ★ 关键一步：旧库的 WAL 必须清掉
  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }

  fs.copyFileSync(backupFile, dbPath);

  const after = inspectBackup(dbPath);
  if (!after.ok) {
    // 恢复失败就把原来的换回去，别把人卡在半路
    if (moved) {
      fs.rmSync(dbPath, { force: true });
      fs.renameSync(moved, dbPath);
    }
    throw new Error(`恢复后的库没通过校验，已回退到原库：${JSON.stringify(after)}`);
  }

  return { ok: true, dbPath, restoredFrom: backupFile, safetyCopy: moved, counts: after.counts };
}

/* ============================================================
   CLI
   ============================================================ */

function env(name, fallback = null) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function main(argv) {
  const cmd = argv[0] || 'backup';
  const dbPath = env('DB_PATH', '/srv/bazaar/data/bazaar.db');
  const backupDir = env('BACKUP_DIR', '/srv/bazaar/backup');
  const keep = Number(env('BACKUP_KEEP', '14'));

  if (cmd === 'backup') {
    const db = new DatabaseSync(dbPath);
    try {
      const out = path.join(backupDir, timestampName());
      const { bytes } = backupDatabase(db, out);
      const info = inspectBackup(out);
      if (!info.ok) throw new Error(`备份校验失败：${JSON.stringify(info)}`);

      const removed = pruneBackups(backupDir, keep);
      console.log(`✅ 备份完成 ${out}（${(bytes / 1024).toFixed(0)} KB）`);
      console.log(`   行数 ${JSON.stringify(info.counts)}`);
      if (removed.length) console.log(`   清理旧备份 ${removed.length} 份：${removed.join(', ')}`);
    } finally {
      db.close();
    }
    return;
  }

  if (cmd === 'list') {
    const list = listBackups(backupDir);
    if (!list.length) { console.log('（没有备份）'); return; }
    for (const b of list) {
      console.log(`${b.name}  ${(b.bytes / 1024).toFixed(0)} KB`);
    }
    return;
  }

  if (cmd === 'verify') {
    const file = argv[1];
    if (!file) throw new Error('用法：node server/backup.mjs verify <文件>');
    const info = inspectBackup(file);
    console.log(JSON.stringify(info, null, 2));
    if (!info.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'restore') {
    const file = argv[1];
    if (!file) throw new Error('用法：DB_PATH=... node server/backup.mjs restore <文件> --yes');
    if (!argv.includes('--yes')) {
      throw new Error('恢复会覆盖线上数据库。确认无误后加上 --yes 再执行。\n' +
                      '执行前请先停服务：sudo systemctl stop bazaar');
    }
    const r = restoreBackup(file, dbPath);
    console.log(`✅ 已恢复 ${dbPath}`);
    console.log(`   来源 ${r.restoredFrom}`);
    if (r.safetyCopy) console.log(`   原库留底 ${r.safetyCopy}`);
    console.log(`   行数 ${JSON.stringify(r.counts)}`);
    console.log('   现在可以起服务了：sudo systemctl start bazaar');
    return;
  }

  throw new Error(`未知命令：${cmd}\n可用：backup | list | verify | restore`);
}

// 只有直接执行时才跑 CLI，被 import 时不跑
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`[x] ${e.message}`);
    process.exit(1);
  }
}
