/**
 * 数据库连接与建表。
 *
 * 用 Node 24 内置的 node:sqlite —— 零第三方依赖，符合本仓库一贯做法。
 *
 * 设计上刻意保留了两道独立的防线来防超卖：
 *   1. 应用层：带条件的原子 UPDATE，检查 changes 是否为 1
 *   2. 数据库层：CHECK (remaining_quota >= 0)
 * 就算第 1 道写错了，第 2 道也会让事务失败，而不是静默变成负数。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA = `
-- ============================================================
-- 用户：学生 / 志愿者 / 管理员
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  openid     TEXT NOT NULL,
  sid        TEXT,                              -- 学号，志愿者/管理员可空
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'student',   -- student | volunteer | admin | owner
  created_at INTEGER NOT NULL
);
-- openid 唯一：一个微信号只能登记一次，这是唯一可靠的防多开小号手段
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_openid ON users(openid);
-- sid 唯一：一个学号只能登记一次。SQLite/MySQL/PostgreSQL 的唯一索引都
-- 允许多个 NULL 并存，所以志愿者这类没有学号的账号不受影响。
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_sid ON users(sid);

-- ============================================================
-- 场次：义卖是周期性活动，一切数据都挂在 event 下
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  starts_at  INTEGER,
  ends_at    INTEGER,
  status     TEXT NOT NULL DEFAULT 'draft',     -- draft | on_sale | ended
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stalls (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id),
  name       TEXT NOT NULL,
  loc        TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_stalls_event ON stalls(event_id);

-- ============================================================
-- 物品
-- 注意：没有、也不允许有任何金额字段
-- ============================================================
CREATE TABLE IF NOT EXISTS items (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id),
  stall_id        TEXT REFERENCES stalls(id),
  name            TEXT NOT NULL,
  description     TEXT,
  emoji           TEXT,                          -- 原型占位图；正式版换成图片列表
  tint            TEXT,
  total_quota     INTEGER NOT NULL CHECK (total_quota >= 0),
  remaining_quota INTEGER NOT NULL CHECK (remaining_quota >= 0),
  status          TEXT NOT NULL DEFAULT 'on_sale',   -- on_sale | off_shelf
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_items_event ON items(event_id, status);

-- ============================================================
-- 预定
-- ============================================================
CREATE TABLE IF NOT EXISTS reservations (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id),
  item_id      TEXT NOT NULL REFERENCES items(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  qty          INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  code         TEXT NOT NULL,                   -- 取货码
  status       TEXT NOT NULL DEFAULT 'reserved',-- reserved | redeemed | cancelled
  request_id   TEXT NOT NULL,                   -- 幂等键，由客户端生成
  active_key   TEXT,                            -- 见下方说明
  created_at   INTEGER NOT NULL,
  redeemed_at  INTEGER,
  operator_id  TEXT,
  cancelled_at INTEGER
);

-- 幂等：同一个 requestId 重放只会命中已有记录，不会重复下单
CREATE UNIQUE INDEX IF NOT EXISTS ux_res_request_id ON reservations(request_id);

-- 取货码在同一个场次内唯一
CREATE UNIQUE INDEX IF NOT EXISTS ux_res_code ON reservations(event_id, code);

-- 「同一件物品每人只能有一笔待取货预定」，但取消之后要允许重新预定。
-- 用 active_key 解决：待取货时值为 event:item:user，取消/核销后置为 NULL。
-- 唯一索引允许多个 NULL 并存，所以这个写法在 SQLite / MySQL / PostgreSQL
-- 三种数据库上行为一致，也方便日后迁到云开发。
CREATE UNIQUE INDEX IF NOT EXISTS ux_res_active ON reservations(active_key);

CREATE INDEX IF NOT EXISTS ix_res_user ON reservations(event_id, user_id, status);
CREATE INDEX IF NOT EXISTS ix_res_item ON reservations(item_id, status);

-- ============================================================
-- 审计日志：谁在什么时候改了什么（换届纠纷时唯一的凭据）
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_target ON audit_logs(target_type, target_id);
`;

/**
 * 打开数据库。
 * @param {string} file 文件路径，或 ':memory:'
 */
export function openDatabase(file = ':memory:') {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);

  // ★ 顺序很重要：必须先设 busy_timeout，再切 WAL。
  //   反过来写的话，多个连接同时启动时 journal_mode 这个 pragma 会立刻
  //   抛 "database is locked"（errcode 261），因为那时还没有等待机制。
  db.exec('PRAGMA busy_timeout = 10000');

  if (file !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // 已经有别的连接切成 WAL 了。目的已达成，忽略即可。
    }
  }

  db.exec('PRAGMA foreign_keys = ON');

  return db;
}

/** 建表（幂等，可重复执行） */
export function migrate(db) {
  db.exec(SCHEMA);
  return db;
}

export function openMigrated(file = ':memory:') {
  return migrate(openDatabase(file));
}
