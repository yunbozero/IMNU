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

/**
 * 数据库路径的**唯一来源**。
 *
 * 之前这几处各写一份默认值，结果本地联调时服务连 tmp/bazaar-dev.db、
 * set-owner 却连 tmp/bazaar.db —— 两个不同的文件，现象是「明明登记过了却说没有用户」。
 * 所以只在这里定义，谁要用谁 import。
 */

/** 线上路径。同时也是「这是线上」的判据之一（见 http.mjs 的 resolveRuntime） */
export const PROD_DB_PATH = '/srv/bazaar/data/bazaar.db';

/** 本地联调用的库，放在已被 .gitignore 挡掉的 tmp/ 下 */
export const DEV_DB_PATH = 'tmp/bazaar-dev.db';

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
  emoji           TEXT,                          -- 图标：一个 emoji 或两个字
  tint            TEXT,                          -- 图标底色，对应 app.wxss 里的 .t-*
  image           TEXT,                          -- 物品照片的文件名（不是完整 URL），见 server/images.mjs
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

-- ============================================================
-- 运行期设置：管理员在界面里能改的开关
--
-- 只放「改了要立刻生效、而且不该需要重启服务」的东西。
-- 环境变量里的值当默认用；表里有行就以表里的为准（见 repository.tryReserve）。
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ============================================================
-- 猫猫图鉴
--
-- ★ 这一张表就是图鉴的**唯一事实来源**（原来是编译在小程序包里的
--   miniprogram/data/cats.js）。搬进数据库是为了**改资料和加猫都不用发版** ——
--   照片、性格、在不在校这些三天两头要动，而发一次版要等 1–2 天审核。
--
-- 代价（明确写下来，免得以后有人问「为什么不放包里」）：
--   · 图鉴页从「零网络请求、断网也能看」变成要发一次请求 ——
--     客户端先用本地缓存同步渲染，所以首屏不会白，断网仍显示上次的结果；
--   · 加一只猫多了一次网络往返，不再随包一起下去。
--   这两条换「不用发版」是值得的：图鉴是 tabBar 一级页面，内容会一直变。
--
-- 没有软删除：没有任何东西引用猫（预定记录指向的是物品），
-- 所以删就是真删。误删靠审计日志找回线索，界面上会二次确认。
-- 离世是一个**状态**（status='passed'），不是删除 —— 图鉴里要留着纪念。
-- ============================================================
CREATE TABLE IF NOT EXISTS cats (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  emoji       TEXT,                              -- 没照片时的图标，一个 emoji 或两个字
  tint        TEXT,                              -- 图标底色，对应 app.wxss 里的 .t-*
  image       TEXT,                              -- 照片文件名（不是完整 URL），见 server/images.mjs
  status      TEXT NOT NULL DEFAULT 'onCampus',  -- onCampus | missing | passed
  gender      TEXT,                              -- 公 | 母 | 未知
  location    TEXT,                              -- 常在哪儿出没
  personality TEXT,                              -- 性格
  note        TEXT,                              -- 其它要提醒的（绝育、胆小、线索…）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
-- 列表按录入顺序排（图鉴里在校猫的先后次序就是这个）。
-- 没有「拖动排序」的界面：图鉴不是需要精排的内容，而做一个拖拽排序
-- 在手机上既难用又难测。真想调顺序就改 created_at。
CREATE INDEX IF NOT EXISTS ix_cats_status ON cats(status, created_at);
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

/**
 * 建表之后还要补的列。
 *
 * ★ 为什么必须单独有一份：SCHEMA 里全是 `CREATE TABLE IF NOT EXISTS` ——
 *   对**已经存在**的表它一个字也不做。所以往 items 上加一列，
 *   新库靠 SCHEMA 就有了，**老库必须 ALTER**，否则线上会报
 *   `no such column: image`，而报错位置在具体的查询里，看起来完全不像
 *   「表结构没跟上」，很容易往别处找原因。
 *
 * 规则：只能加**可空**的列（SQLite 的 ADD COLUMN 不允许「非空且无默认值」）。
 * 每一项都必须可以重复执行 —— 判断依据是「这一列在不在」，不是版本号：
 * 版本号一旦被人手工改库或从备份恢复就会错位，而「列在不在」永远是真的。
 */
const ADDED_COLUMNS = [
  { table: 'items', column: 'image', ddl: 'ALTER TABLE items ADD COLUMN image TEXT' },
];

/** 某张表当前有哪些列。表不存在时返回空集合。 */
function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
}

/** 建表（幂等，可重复执行），并把老库缺的列补上 */
export function migrate(db) {
  db.exec(SCHEMA);

  for (const { table, column, ddl } of ADDED_COLUMNS) {
    if (!tableColumns(db, table).has(column)) db.exec(ddl);
  }

  return db;
}

export function openMigrated(file = ':memory:') {
  return migrate(openDatabase(file));
}
