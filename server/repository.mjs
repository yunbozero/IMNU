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
  'getActiveEvent',
  'listEvents',
  'updateEventStatus',
  'createStall',
  'listStalls',
  'createItem',
  'createUser',
  'findUserByOpenid',
  'findUserById',
  'listUsers',
  'listItems',
  'getItem',
  'tryReserve',
  'getReservation',
  'findByCode',
  'listUserReservations',
  'listEventReservations',
  'cancelReservation',
  'redeem',
  'undoRedeem',
  'updateItem',
  'setUserRole',
  'bootstrapOwner',
  'transferOwnership',
  'countOwners',
  'getSetting',
  'setSetting',
  'clearSetting',
  'writeAudit',
];

const now = () => Date.now();
const newId = (p) => `${p}_${randomUUID()}`;

/**
 * 设置表里的 key：每个账号在本次活动内最多预定几件。
 *
 * 值优先取自数据库 —— 管理员在界面上改完**下一笔预定就生效**，不用重启服务。
 * 表里没有这一行时，回落到调用方传来的默认值（来自环境变量 MAX_ITEMS_PER_USER）。
 */
export const SETTING_MAX_PER_USER = 'maxItemsPerUser';

/**
 * 上限最终取值：**数据库里的值优先，否则用兜底值**（来自环境变量）。
 *
 * 存的值坏掉时（有人手改数据库）也回落到兜底，而不是变成「不限」——
 * 但更不能把所有人的预定都堵死。抽成一个函数是因为规则只能有一处，
 * 仓储里的判定和接口返回给管理员的当前值必须是同一个答案。
 */
export function pickMaxPerUser(storedValue, fallback) {
  const n = storedValue === null || storedValue === undefined ? null : Number(storedValue);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

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
  description: r.description, emoji: r.emoji, tint: r.tint, image: r.image,
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

const mapEvent = (r) => (r ? {
  id: r.id, name: r.name, startsAt: r.starts_at, endsAt: r.ends_at, status: r.status,
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

    /**
     * 当前正在进行的场次。
     * 同一时间只应该有一个，取最新创建的那个；没有就返回 null，
     * 由上层给出「活动还没开始」这类提示，而不是抛错。
     */
    getActiveEvent() {
      const r = db.prepare(`
        SELECT * FROM events WHERE status = 'on_sale'
         ORDER BY created_at DESC LIMIT 1
      `).get();
      return mapEvent(r);
    },

    /**
     * 全部场次，最新创建的在前。
     *
     * 为什么需要它：`getActiveEvent` 只认 on_sale 的那一个，草稿和已结束的
     * 场次它一律看不见。而初始化脚本要靠「这个活动是不是已经建过了」来决定
     * 新建还是复用 —— 只看得见 on_sale 的话，一个草稿状态的同名活动会被
     * 再建一遍，变成两个活动。
     */
    listEvents() {
      return db.prepare('SELECT * FROM events ORDER BY created_at DESC').all().map(mapEvent);
    },

    /**
     * 改场次状态：draft / on_sale / ended。
     *
     * 义卖结束之后要能把场次收尾 —— 不然它会一直挂着「在售」，
     * 而 `getActiveEvent` 只认最新的在售场次，下次办活动就会互相打架。
     *
     * ★ 这里**不检查「同时只能有一个在售」**。那是业务不变量，
     *   由接口层在调用前判断（它需要先读一遍当前在售的是谁，
     *   才给得出「先把「X」结束掉吗」这种话）。数据层只负责写。
     */
    updateEventStatus(eventId, status) {
      if (!['draft', 'on_sale', 'ended'].includes(status)) {
        throw new Error(`未知的场次状态：${status}`);
      }
      const upd = db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, eventId);
      if (upd.changes !== 1) return { ok: false, reason: 'not_found' };
      return { ok: true, event: repo.listEvents().find((e) => e.id === eventId) };
    },

    createStall({ eventId, name, loc = null }) {
      const id = newId('st');
      db.prepare(`INSERT INTO stalls (id,event_id,name,loc,created_at)
                  VALUES (?,?,?,?,?)`).run(id, eventId, name, loc, now());
      return { id, eventId, name, loc };
    },

    listStalls(eventId) {
      return db.prepare('SELECT * FROM stalls WHERE event_id = ? ORDER BY created_at')
        .all(eventId).map(mapStall);
    },

    createItem({ eventId, stallId = null, name, description = null, emoji = null,
                 tint = null, image = null, totalQuota, remainingQuota = null, status = 'on_sale' }) {
      const id = newId('it');
      const remaining = remainingQuota === null ? totalQuota : remainingQuota;
      db.prepare(`INSERT INTO items
        (id,event_id,stall_id,name,description,emoji,tint,image,total_quota,remaining_quota,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, eventId, stallId, name, description, emoji, tint, image,
             totalQuota, remaining, status, now());
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

    /**
     * 全部已登记的账号，按登记先后。
     *
     * 给服务端脚本用（set-owner / set-role 都要按昵称找出「手机上那个账号」
     * 是哪一个）。以前这些脚本直接在这里写 SQL，绕过了数据层 ——
     * 将来换云开发时，散落在脚本里的 SQL 是最容易漏改的一批。
     */
    listUsers() {
      return db.prepare('SELECT * FROM users ORDER BY created_at').all().map(mapUser);
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
    tryReserve({ eventId, itemId, userId, qty = 1, requestId, code, maxPerUser = null }) {
      if (!requestId) throw new Error('requestId 必填：它是防重复提交的幂等键');
      if (!code) throw new Error('code 必填：取货码由调用方生成');
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('qty 必须是正整数');

      // 幂等：这个请求之前处理过，直接把当时的结果还给他
      const seen = db.prepare('SELECT * FROM reservations WHERE request_id = ?').get(requestId);
      if (seen) {
        return { ok: true, idempotent: true, reservation: mapReservation(seen) };
      }

      return inTransactionAbortable(db, () => {
        // ★ 每账号上限：优先取数据库里的设置 —— 管理员在界面上改完，
        //   **下一笔预定就生效**，不用重启服务。
        //   表里没有那一行时回落到 maxPerUser（来自环境变量）。
        //   存的值坏掉时（有人手改数据库）也回落到默认 —— 不能变成「不限」，
        //   但更不能把所有人的预定都堵死。
        const storedRow = db.prepare('SELECT value FROM settings WHERE key = ?')
          .get(SETTING_MAX_PER_USER);
        const limit = pickMaxPerUser(storedRow ? storedRow.value : null, maxPerUser);

        // ★ 先数一遍再扣减。
        //   事务用的是 BEGIN IMMEDIATE，进门就拿到写锁，所以这个数字在本次写入前
        //   不会被别人改动 —— 计数和扣减之间没有窗口，不需要额外加锁。
        //   数的是 reserved + redeemed：核销掉的名额同样算「已经拿过」，
        //   否则先取货再接着定就能绕过上限。
        if (Number.isInteger(limit) && limit > 0) {
          const held = db.prepare(`
            SELECT COALESCE(SUM(qty), 0) AS s FROM reservations
             WHERE event_id = ? AND user_id = ? AND status IN ('reserved', 'redeemed')
          `).get(eventId, userId).s;

          if (held + qty > limit) {
            return abort({ ok: false, reason: 'too_many', limit, current: held });
          }
        }

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
     * 某场次的全部预定 —— 管理后台看名单、导出纸质兜底名单都要用。
     * status 可选，不传就是全部。
     */
    listEventReservations(eventId, { status = null } = {}) {
      const rows = status
        ? db.prepare('SELECT * FROM reservations WHERE event_id = ? AND status = ? ORDER BY created_at')
            .all(eventId, status)
        : db.prepare('SELECT * FROM reservations WHERE event_id = ? ORDER BY created_at')
            .all(eventId);

      const items = new Map(
        db.prepare('SELECT id, name FROM items WHERE event_id = ?').all(eventId).map((r) => [r.id, r])
      );
      const users = new Map(
        db.prepare('SELECT id, name, sid FROM users').all().map((r) => [r.id, r])
      );

      return rows.map((r) => {
        const it = items.get(r.item_id);
        const u = users.get(r.user_id);
        return {
          ...mapReservation(r),
          itemName: it ? it.name : null,
          userName: u ? u.name : null,
          userSid: u ? u.sid : null,
        };
      });
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

    /* ---------------- 管理端 ---------------- */

    /**
     * 撤销一次误核销。
     *
     * 注意 active_key 不用动：核销时它**没有被清空**（取消才清空），
     * 所以撤销回来之后「每人每件只能预定一次」这条约束依然是连贯的。
     * 如果核销时把 active_key 清了，这里就要处理"他已经又预定了一次"的冲突 —— 那是自找麻烦。
     */
    undoRedeem(reservationId, actorId = null) {
      return inTransactionAbortable(db, () => {
        const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId);
        if (!r) return abort({ ok: false, reason: 'not_found' });
        if (r.status !== 'redeemed') {
          return abort({ ok: false, reason: 'not_redeemed', message: '这笔预定并没有被核销' });
        }

        const upd = db.prepare(`
          UPDATE reservations
             SET status = 'reserved', redeemed_at = NULL, operator_id = NULL
           WHERE id = ? AND status = 'redeemed'
        `).run(reservationId);

        if (upd.changes !== 1) return abort({ ok: false, reason: 'conflict' });

        // 名额不受影响：核销本来就没退名额，撤销自然也不动
        return { ok: true, reservation: repo.getReservation(reservationId), undoneBy: actorId };
      });
    },

    /**
     * 改物品：上下架、增减名额、换图。
     *
     * 名额用增量而不是绝对值，并且会拦住两种会破坏账目的改法：
     *   - 把总数压到已锁定数量以下（已经有 10 个人预定了，总数不能设成 5）
     *   - 把剩余名额改成负数
     *
     * ★ image 是**三态**：不传（undefined）= 不动；null = 清掉；文件名 = 换成它。
     *   不能照抄 status 那种「null 表示不动」的写法 —— 对图片来说 null 是个
     *   有意义的值（把图删掉，回落到 emoji）。
     */
    updateItem({ itemId, status = null, quotaDelta = 0, image = undefined }) {
      if (status !== null && !['on_sale', 'off_shelf'].includes(status)) {
        throw new Error(`未知的物品状态：${status}`);
      }
      if (!Number.isInteger(quotaDelta)) throw new Error('quotaDelta 必须是整数');
      if (image !== undefined && image !== null && typeof image !== 'string') {
        throw new Error('image 要么是文件名、要么是 null，要么干脆不传');
      }

      return inTransactionAbortable(db, () => {
        const it = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
        if (!it) return abort({ ok: false, reason: 'not_found' });

        let { total_quota: total, remaining_quota: remaining } = it;

        if (quotaDelta !== 0) {
          const held = db.prepare(`
            SELECT COALESCE(SUM(qty), 0) AS s FROM reservations
             WHERE item_id = ? AND status IN ('reserved', 'redeemed')
          `).get(itemId).s;

          const newTotal = total + quotaDelta;
          const newRemaining = remaining + quotaDelta;

          if (newTotal < held) {
            return abort({
              ok: false, reason: 'quota_below_locked',
              message: `已经有 ${held} 份被预定了，总数不能降到 ${newTotal}`,
            });
          }
          if (newRemaining < 0) {
            return abort({ ok: false, reason: 'quota_negative', message: '剩余名额不能为负' });
          }
          total = newTotal;
          remaining = newRemaining;
        }

        db.prepare(`UPDATE items SET status = ?, total_quota = ?, remaining_quota = ?, image = ?
                     WHERE id = ?`)
          .run(status === null ? it.status : status, total, remaining,
               image === undefined ? it.image : image, itemId);

        return { ok: true, item: repo.getItem(itemId), quotaDelta };
      });
    },

    /**
     * 直接设置某个人的角色。
     * ★ 这里**不做权限判断** —— 策略在 roles.mjs，由接口层调 checkRoleChange。
     *   数据层只保证"不出现第二个超管"这种结构性问题。
     */
    setUserRole(userId, role) {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!u) return { ok: false, reason: 'not_found' };
      if (role === 'owner') return { ok: false, reason: 'use_transfer' };

      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
      return { ok: true, user: repo.findUserById(userId), from: u.role, to: role };
    },

    /**
     * 设立第一个超管。
     *
     * 必须有这个方法，否则会死锁：转交要求已有一个超管，
     * 而 setUserRole 又拒绝直接设成 owner —— 那第一个超管永远产生不了。
     *
     * 安全性靠「只在当前没有任何超管时才生效」保证：
     * 一旦有了超管，它永远拒绝，所以没法拿它来抢权限。
     * ★ 这个方法**不暴露成 HTTP 接口**，只由服务端初始化脚本调用。
     */
    bootstrapOwner(userId) {
      return inTransactionAbortable(db, () => {
        if (repo.countOwners() > 0) {
          return abort({ ok: false, reason: 'already_has_owner' });
        }
        const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (!u) return abort({ ok: false, reason: 'not_found' });

        db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(userId);
        return { ok: true, user: repo.findUserById(userId) };
      });
    },

    /**
     * 转交超管。必须在一个事务里完成，否则中间态会出现两个超管或零个超管。
     */
    transferOwnership({ fromUserId, toUserId }) {
      return inTransactionAbortable(db, () => {
        const from = db.prepare('SELECT * FROM users WHERE id = ?').get(fromUserId);
        const to = db.prepare('SELECT * FROM users WHERE id = ?').get(toUserId);

        if (!from || !to) return abort({ ok: false, reason: 'not_found' });
        if (from.role !== 'owner') return abort({ ok: false, reason: 'not_owner' });
        if (fromUserId === toUserId) return abort({ ok: false, reason: 'self_transfer' });

        // 原超管降为一级管理员，而不是降成学生 ——
        // 换届之后他通常还要帮忙带一段时间
        db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(fromUserId);
        db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(toUserId);

        const owners = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'owner'").get().c;
        if (owners !== 1) return abort({ ok: false, reason: 'invariant_violated' });

        return {
          ok: true,
          from: repo.findUserById(fromUserId),
          to: repo.findUserById(toUserId),
        };
      });
    },

    countOwners() {
      return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'owner'").get().c;
    },

    /* ---------------- 运行期设置 ---------------- */

    getSetting(key) {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return r ? r.value : null;
    },

    /** 写设置。同 key 覆盖。 */
    setSetting(key, value) {
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, String(value), now());
      return { ok: true };
    },

    /** 删掉设置行 —— 效果是回落到默认值（环境变量那个） */
    clearSetting(key) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return { ok: true };
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
