/**
 * 数据访问层（repository）。
 *
 * ★ 这是整个项目里最重要的一个文件。
 *
 * 为什么要有这一层：一年后要从 SQLite 迁到微信云开发。只要业务代码
 * 只通过本文件暴露的方法访问数据、不直接写 SQL，迁移时只需要再写一个
 * createCloudRepository()，业务代码一行都不用改。
 *
 * 迁移时要换的只有这一层：
 *   - tryReserve 的 SQL 条件更新  →  云数据库的 where().update() + stats.updated
 *   - createUser 的唯一索引冲突   →  云数据库的唯一索引错误码
 *   - redeem 的状态转换            →  同样是条件更新
 * 业务语义（防超卖、幂等、单向核销）完全不变。
 *
 * tests/repository-contract.mjs 是一份"任何实现都必须通过"的契约测试。
 * 将来写好云开发版本，把契约测试换个实现跑一遍就证明迁移没走样。
 */
import { randomUUID } from 'node:crypto';

/** 契约：任何后端实现都必须提供这些方法，签名一致 */
export const REPOSITORY_METHODS = [
  'createEvent',
  'createStall',
  'createItem',
  'createUser',
  'findUserByOpenid',
  'findUserById',
  'listItems',
  'getItem',
  'tryReserve',
  'getReservation',
  'findByCode',
  'listUserReservations',
  'cancelReservation',
  'redeem',
  'writeAudit',
];

const now = () => Date.now();
const newId = (p) => `${p}_${randomUUID()}`;

/** SQLite 唯一索引冲突 */
function isUniqueViolation(e) {
  const s = `${e && e.message} ${e && e.code}`;
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(s);
}

/**
 * 取出冲突的是哪个索引 / 哪一列。
 * SQLite 的报错形如：
 *   UNIQUE constraint failed: reservations.event_id, reservations.code
 *   UNIQUE constraint failed: reservations.active_key
 * ★ 必须区分它们：`active_key` 冲突是"你已经预定过这件物品了"，
 *   `code` 冲突是"取货码撞车了"。混成一个原因，学生会收到完全对不上的提示。
 */
function uniqueTarget(e) {
  const m = /UNIQUE constraint failed:\s*(.+)/i.exec(String((e && e.message) || ''));
  return m ? m[1].trim() : '';
}

const mapUser = (r) => (r ? {
  id: r.id, openid: r.openid, sid: r.sid, name: r.name,
  role: r.role, createdAt: r.created_at,
} : null);

const mapItem = (r) => (r ? {
  id: r.id, eventId: r.event_id, stallId: r.stall_id, name: r.name,
  description: r.description, emoji: r.emoji, tint: r.tint,
  totalQuota: r.total_quota, remainingQuota: r.remaining_quota,
  status: r.status, createdAt: r.created_at,
} : null);

const mapReservation = (r) => (r ? {
  id: r.id, eventId: r.event_id, itemId: r.item_id, userId: r.user_id,
  qty: r.qty, code: r.code, status: r.status, requestId: r.request_id,
  createdAt: r.created_at, redeemedAt: r.redeemed_at,
  operatorId: r.operator_id, cancelledAt: r.cancelled_at,
} : null);

const mapStall = (r) => (r ? {
  id: r.id, eventId: r.event_id, name: r.name, loc: r.loc, createdAt: r.created_at,
} : null);

/**
 * 用事务包住一段写操作。
 * BEGIN IMMEDIATE 立刻拿写锁，避免多个连接同时读后升级写锁造成的死锁。
 */
function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 事务可能已结束 */ }
    throw e;
  }
}

/**
 * 中途要"提前返回"的写操作，用它包：返回 { value } 表示正常提交，
 * 返回 { abort } 表示回滚并把 abort 作为结果返回。
 */
function inTransactionAbortable(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  let result;
  try {
    result = fn();
    if (result && result.__abort) {
      db.exec('ROLLBACK');
      return result.value;
    }
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 事务可能已结束 */ }
    throw e;
  }
}

const abort = (value) => ({ __abort: true, value });

/* ============================================================
   SQLite 实现
   ============================================================ */

export function createSqliteRepository(db) {
  const repo = {

    /* ---------------- 场次 / 摊位 ---------------- */

    createEvent({ name, startsAt = null, endsAt = null, status = 'draft' }) {
      const id = newId('ev');
      db.prepare(`INSERT INTO events (id,name,starts_at,ends_at,status,created_at)
                  VALUES (?,?,?,?,?,?)`).run(id, name, startsAt, endsAt, status, now());
      return { id, name, startsAt, endsAt, status };
    },

    createStall({ eventId, name, loc = null }) {
      const id = newId('st');
      db.prepare(`INSERT INTO stalls (id,event_id,name,loc,created_at)
                  VALUES (?,?,?,?,?)`).run(id, eventId, name, loc, now());
      return { id, eventId, name, loc };
    },

    createItem({ eventId, stallId = null, name, description = null, emoji = null,
                 tint = null, totalQuota, remainingQuota = null, status = 'on_sale' }) {
      const id = newId('it');
      const remaining = remainingQuota === null ? totalQuota : remainingQuota;
      db.prepare(`INSERT INTO items
        (id,event_id,stall_id,name,description,emoji,tint,total_quota,remaining_quota,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, eventId, stallId, name, description, emoji, tint, totalQuota, remaining, status, now());
      return repo.getItem(id);
    },

    /* ---------------- 用户 ---------------- */

    createUser({ openid, sid = null, name, role = 'student' }) {
      const id = newId('u');
      try {
        db.prepare(`INSERT INTO users (id,openid,sid,name,role,created_at)
                    VALUES (?,?,?,?,?,?)`).run(id, openid, sid, name, role, now());
        return { ok: true, user: repo.findUserById(id) };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        // 分辨到底是哪个唯一索引冲突，前端要给出不同提示
        const target = uniqueTarget(e);
        if (/openid/i.test(target)) return { ok: false, reason: 'openid_taken' };
        if (/sid/i.test(target)) return { ok: false, reason: 'sid_taken' };
        // 兜底：约束名认不出来时再查一次库
        if (db.prepare('SELECT 1 FROM users WHERE openid = ?').get(openid)) {
          return { ok: false, reason: 'openid_taken' };
        }
        return { ok: false, reason: 'sid_taken' };
      }
    },

    findUserByOpenid(openid) {
      return mapUser(db.prepare('SELECT * FROM users WHERE openid = ?').get(openid));
    },

    findUserById(id) {
      return mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    },

    /* ---------------- 物品 ---------------- */

    listItems(eventId, { onlyOnSale = false } = {}) {
      const sql = onlyOnSale
        ? `SELECT * FROM items WHERE event_id = ? AND status = 'on_sale' ORDER BY created_at`
        : `SELECT * FROM items WHERE event_id = ? ORDER BY created_at`;
      return db.prepare(sql).all(eventId).map(mapItem);
    },

    getItem(id) {
      return mapItem(db.prepare('SELECT * FROM items WHERE id = ?').get(id));
    },

    /* ---------------- 预定（核心） ---------------- */

    /**
     * 锁定名额。这是整个系统里唯一会扣减名额的地方。
     *
     * 四种失败原因要区分清楚，前端文案不一样：
     *   soldout    名额不足
     *   off_shelf  物品已下架
     *   dup        同一人对同一物品已有一笔待取货预定
     *   code_taken 取货码撞车，调用方换个码重试即可（名额不会被扣掉）
     *   not_found  物品不存在
     *
     * requestId 重复提交是幂等的，返回第一次的结果而不是报错——
     * 学生手抖点两次「预定」不应该产生两单，也不应该看到报错。
     */
    tryReserve({ eventId, itemId, userId, qty = 1, requestId, code }) {
      if (!requestId) throw new Error('requestId 必填：它是防重复提交的幂等键');
      if (!code) throw new Error('code 必填：取货码由调用方生成');
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('qty 必须是正整数');

      // 幂等：这个请求之前处理过，直接把当时的结果还给他
      const seen = db.prepare('SELECT * FROM reservations WHERE request_id = ?').get(requestId);
      if (seen) {
        return { ok: true, idempotent: true, reservation: mapReservation(seen) };
      }

      return inTransactionAbortable(db, () => {
        // ★ 原子扣减：条件判断和更新在同一条语句里完成。
        //   绝不允许"先查剩余、再扣减"——那样两个人同时抢最后一件就会超卖。
        const upd = db.prepare(`
          UPDATE items
             SET remaining_quota = remaining_quota - ?
           WHERE id = ?
             AND status = 'on_sale'
             AND remaining_quota >= ?
        `).run(qty, itemId, qty);

        if (upd.changes !== 1) {
          const it = db.prepare('SELECT status FROM items WHERE id = ?').get(itemId);
          if (!it) return abort({ ok: false, reason: 'not_found' });
          if (it.status !== 'on_sale') return abort({ ok: false, reason: 'off_shelf' });
          return abort({ ok: false, reason: 'soldout' });
        }

        const id = newId('r');
        try {
          db.prepare(`INSERT INTO reservations
            (id,event_id,item_id,user_id,qty,code,status,request_id,active_key,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(id, eventId, itemId, userId, qty, code, 'reserved', requestId,
                 `${eventId}:${itemId}:${userId}`, now());
        } catch (e) {
          if (isUniqueViolation(e)) {
            const target = uniqueTarget(e);
            // 取货码撞车：调用方应当换一个码重试，名额已经被这次回滚还回去了
            if (/code/i.test(target)) return abort({ ok: false, reason: 'code_taken' });
            // active_key 冲突 = 这个人已经有一笔待取货预定了。
            // 回滚会一并撤销上面那次数名额扣减，所以不会漏。
            return abort({ ok: false, reason: 'dup' });
          }
          throw e;
        }

        const item = db.prepare('SELECT remaining_quota FROM items WHERE id = ?').get(itemId);
        return { ok: true, reservation: repo.getReservation(id), remaining: item.remaining_quota };
      });
    },

    getReservation(id) {
      return mapReservation(db.prepare('SELECT * FROM reservations WHERE id = ?').get(id));
    },

    findByCode(eventId, code) {
      return mapReservation(
        db.prepare('SELECT * FROM reservations WHERE event_id = ? AND code = ?').get(eventId, code)
      );
    },

    listUserReservations(eventId, userId) {
      return db.prepare(`SELECT * FROM reservations
                          WHERE event_id = ? AND user_id = ?
                          ORDER BY created_at DESC`).all(eventId, userId).map(mapReservation);
    },

    /**
     * 取消预定并把名额还回去。
     * 关键：只有 reserved → cancelled 这一次状态转换成功，才允许加名额。
     * 否则重复点击「取消」会让名额虚增。
     */
    cancelReservation(id) {
      return inTransactionAbortable(db, () => {
        const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
        if (!r) return abort({ ok: false, reason: 'not_found' });
        if (r.status !== 'reserved') return abort({ ok: false, reason: r.status });

        const upd = db.prepare(`
          UPDATE reservations
             SET status = 'cancelled', active_key = NULL, cancelled_at = ?
           WHERE id = ? AND status = 'reserved'
        `).run(now(), id);

        if (upd.changes !== 1) return abort({ ok: false, reason: 'conflict' });

        db.prepare('UPDATE items SET remaining_quota = remaining_quota + ? WHERE id = ?')
          .run(r.qty, r.item_id);

        return { ok: true, released: r.qty, reservation: repo.getReservation(id) };
      });
    },

    /**
     * 核销。单向的状态转换：同一个码只有第一次能成功。
     * 第二次来必须明确告诉志愿者"已经核销过了"，并带上首次核销的时间和人。
     */
    redeem(eventId, code, operatorId = null) {
      return inTransactionAbortable(db, () => {
        const r = db.prepare('SELECT * FROM reservations WHERE event_id = ? AND code = ?')
          .get(eventId, code);

        if (!r) return abort({ ok: false, reason: 'invalid' });
        if (r.status === 'redeemed') {
          return abort({ ok: false, reason: 'redeemed', reservation: mapReservation(r) });
        }
        if (r.status === 'cancelled') {
          return abort({ ok: false, reason: 'cancelled', reservation: mapReservation(r) });
        }

        const upd = db.prepare(`
          UPDATE reservations
             SET status = 'redeemed', redeemed_at = ?, operator_id = ?
           WHERE id = ? AND status = 'reserved'
        `).run(now(), operatorId, r.id);

        if (upd.changes !== 1) return abort({ ok: false, reason: 'conflict' });

        return { ok: true, reservation: repo.getReservation(r.id) };
      });
    },

    /* ---------------- 审计 ---------------- */

    writeAudit({ actorId = null, action, targetType = null, targetId = null, detail = null }) {
      db.prepare(`INSERT INTO audit_logs (actor_id,action,target_type,target_id,detail,created_at)
                  VALUES (?,?,?,?,?,?)`)
        .run(actorId, action, targetType, targetId, detail === null ? null : JSON.stringify(detail), now());
    },

    /* ---------------- 测试辅助 ---------------- */

    /** 仅供测试与本地开发使用 */
    _raw: db,
  };

  return repo;
}

/** 生成 6 位数字取货码，避开已占用的码。 */
export function generateCode(taken = new Set(), digits = 6) {
  const max = 10 ** digits;
  for (let n = 0; n < 500; n++) {
    let c = '';
    for (let i = 0; i < digits; i++) c += Math.floor(Math.random() * 10);
    if (c[0] === '0') c = '1' + c.slice(1);   // 首位不为 0，方便口报
    if (!taken.has(c)) return c;
  }
  return String(Date.now() % max).padStart(digits, '0');
}
