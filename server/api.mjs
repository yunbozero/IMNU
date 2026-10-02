/**
 * 义卖接口。
 *
 * ★ 这一层的职责只有三件事：校验入参、按顺序调 repository、把结果翻译成响应。
 *   一行 SQL 都没有 —— 所以迁到云开发时这一层不用改。
 *
 * 响应约定（刻意区分「传输出错」和「业务失败」）：
 *
 *   200 {ok:true, ...}                成功
 *   200 {ok:false, error, message}    业务失败：约满、重复预定、已核销……
 *                                     —— 用 200，因为这不是 HTTP 层的错，
 *                                        小程序不该把它当成网络异常
 *   400 参数不对   401 没登录   403 没权限
 *   404 路由不存在 405 方法不对 429 请求太频繁 500 服务端 bug
 *
 * 所有 `error` 都是稳定的机器可读字符串，`message` 才是给人看的中文。
 */
import { generateCode, SETTING_MAX_PER_USER, pickMaxPerUser } from './repository.mjs';
import {
  ROLE_LABEL, isRole, canManage, canRedeem,
  checkRoleChange, checkOwnerTransfer,
} from './roles.mjs';

export const API_VERSION = '1.0.0';

/** 单次预定的数量上限。防止有人一次把名额全占了。 */
export const MAX_QTY_PER_RESERVE = 5;
/** 取货码撞车后的重试次数。6 位数字空间很大，撞一次都算罕见。 */
export const CODE_RETRY = 5;
/**
 * 「每账号最多预定几件」这个设置能填到多大。
 * 它影响全场每一个人，所以留个上界拦住手滑（比如打成 1000）。
 */
export const MAX_ITEMS_PER_USER_LIMIT = 100;

const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } });
const fail = (error, message, status = 200) => ({ status, body: { ok: false, error, message } });

const isStaff = (user) => !!user && canRedeem(user.role);
const isManager = (user) => !!user && canManage(user.role);
/**
 * 一级管理员及以上（副主任管理员不算）。
 * 用于「撤销核销」和「改运行期设置」—— 这两件事的影响面比改单个物品大。
 */
const isSeniorManager = (user) => isManager(user) && user.role !== 'deputy';

/* ============================================================
   给小程序看的文案 —— 统一放在一处，前端就不用自己拼
   ============================================================ */

const MESSAGES = {
  soldout: '手慢了，名额刚刚被约满',
  dup: '你已经预定过这件物品了',
  off_shelf: '这件物品已经下架了',
  not_found: '物品不存在',
  code_taken: '取货码生成撞车，请重试',
  invalid_code: '取货码不存在，请核对数字',
  already_redeemed: '这个码已经核销过了',
  cancelled: '该预定已被取消',
  sid_taken: '该学号已登记过，请勿重复登记',
  openid_taken: '这个微信号已经登记过了',
  cancelled_reservation: '该预定已无法取消',
};

export function createApi({
  repo, sessions, secret, signToken,
  startedAt = Date.now(), now = Date.now,
  makeCode = generateCode,
  maxItemsPerUser = 0,          // 每个账号在本次活动内最多预定几件；0 或负数 = 不限
}) {
  if (!repo) throw new Error('createApi 需要 repo');
  if (!signToken) throw new Error('createApi 需要 signToken');

  /* ---------------- 入参校验 ---------------- */

  const asId = (v, max = 64) =>
    typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;

  const asQty = (v) => {
    const n = v === undefined ? 1 : Number(v);
    return Number.isInteger(n) && n >= 1 && n <= MAX_QTY_PER_RESERVE ? n : null;
  };

  const asSid = (v) => (typeof v === 'string' && /^\d{6,16}$/.test(v.trim()) ? v.trim() : null);

  /**
   * 昵称。注意这里**不是**在验证真实姓名。
   *
   * 以前这个字段叫「真实姓名」、限 2–12 字，因为最初的设计要收学号 + 姓名来认人。
   * 现在不用学号、也不验证身份，就不该继续假装它是真名 —— 放开到 1–16 字，
   * 一个字也行（有人昵称就叫「猫」）。
   */
  const asNickname = (v) => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s.length >= 1 && s.length <= 16 ? s : null;
  };

  /** 取消原因。2–60 字：太短没信息量，太长没人会看。 */
  const asReason = (v) => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s.length >= 2 && s.length <= 60 ? s : null;
  };

  /**
   * 生效中的「每账号最多预定几件」。
   * 规则和 repo.tryReserve 里那条是同一个函数（pickMaxPerUser），
   * 免得「设置页显示的值」和「实际拦人的值」不一致。
   */
  const currentMaxPerUser = () =>
    pickMaxPerUser(repo.getSetting(SETTING_MAX_PER_USER), maxItemsPerUser);

  /* ---------------- handlers ---------------- */

  return {
    /* ---------- 健康检查 ---------- */
    health() {
      return ok({
        service: 'bazaar-api',
        version: API_VERSION,
        uptimeMs: now() - startedAt,
        serverTime: now(),
      });
    },

    /* ---------- 活动信息 ---------- */
    getEvent() {
      const event = repo.getActiveEvent();
      if (!event) {
        return ok({ event: null, stalls: [], serverTime: now() });
      }
      return ok({
        event,
        stalls: repo.listStalls(event.id),
        serverTime: now(),
      });
    },

    /* ---------- 物品列表 ---------- */
    listItems() {
      const event = repo.getActiveEvent();
      if (!event) return ok({ event: null, items: [] });

      const stalls = new Map(repo.listStalls(event.id).map((s) => [s.id, s]));
      const items = repo.listItems(event.id, { onlyOnSale: false }).map((it) => {
        const stall = stalls.get(it.stallId);
        return { ...it, stallName: stall ? stall.name : null, stallLoc: stall ? stall.loc : null };
      });

      return ok({ event, items, serverTime: now() });
    },

    /* ---------- 登录 ---------- */
    async login({ body }) {
      const code = typeof body?.code === 'string' ? body.code.trim() : '';
      if (!code || code.length > 128) return fail('bad_request', '缺少 code', 400);

      let session;
      try {
        session = await sessions.exchange(code);
      } catch (e) {
        return fail('login_failed', '微信登录失败，请重试', 401);
      }

      const user = repo.findUserByOpenid(session.openid);
      if (!user) {
        // 还没登记过。给一个「受限 token」：只能拿去调 register，
        // 这样前端不用把 openid 传来传去，也不用手动存中间态。
        const token = signToken({ uid: null, openid: session.openid, scope: 'register' }, secret);
        return ok({ token, registered: false, user: null });
      }

      const token = signToken({ uid: user.id, scope: 'user' }, secret);
      return ok({ token, registered: true, user });
    },

    /* ---------- 身份登记 ---------- */
    register({ body, auth }) {
      if (!auth || auth.scope !== 'register') {
        return fail('unauthorized', '请先登录', 401);
      }

      // 学号是**可选**的。既然不验证身份，就不该收集学号 ——
      // 收一个验证不了的学号只会让人误以为验证过了，顺带还有个隐私负担。
      // 但传了仍然按格式校验并存下来（数据库列和唯一索引都还在，多个 NULL 是允许的），
      // 万一以后哪个院系想用，不用再改表。
      const rawSid = body?.sid === undefined || body?.sid === null || body?.sid === ''
        ? null
        : asSid(body.sid);
      if (body?.sid && !rawSid) {
        return fail('bad_request', '学号格式不对：应为 6–16 位数字', 400);
      }

      const name = asNickname(body?.name);
      if (!name) return fail('bad_request', '请填写昵称（1–16 个字）', 400);

      const r = repo.createUser({ openid: auth.openid, sid: rawSid, name, role: 'student' });
      if (!r.ok) {
        return fail(r.reason, MESSAGES[r.reason] || '登记失败');
      }

      repo.writeAudit({
        actorId: r.user.id, action: 'user.register',
        targetType: 'user', targetId: r.user.id,
        detail: { sid: rawSid },
      });

      const token = signToken({ uid: r.user.id, scope: 'user' }, secret);
      return ok({ user: r.user, token });
    },

    /* ---------- 我的信息 ---------- */
    me({ user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      return ok({ user, isStaff: isStaff(user) });
    },

    /* ---------- 我的预定 ---------- */
    listMyReservations({ user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);

      const event = repo.getActiveEvent();
      if (!event) return ok({ event: null, reservations: [] });

      const items = new Map(repo.listItems(event.id).map((i) => [i.id, i]));
      const stalls = new Map(repo.listStalls(event.id).map((s) => [s.id, s]));

      const reservations = repo.listUserReservations(event.id, user.id).map((r) => {
        const it = items.get(r.itemId);
        const stall = it && stalls.get(it.stallId);
        return {
          ...r,
          itemName: it ? it.name : null,
          emoji: it ? it.emoji : null,
          tint: it ? it.tint : null,
          stallName: stall ? stall.name : null,
          stallLoc: stall ? stall.loc : null,
        };
      });

      return ok({ event, reservations });
    },

    /* ---------- 预定名额（核心） ---------- */
    reserve({ body, user, rateLimited }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (rateLimited) return fail('rate_limited', '操作太频繁，请稍后再试', 429);

      const itemId = asId(body?.itemId);
      const requestId = asId(body?.requestId, 80);
      const qty = asQty(body?.qty);

      if (!itemId) return fail('bad_request', '缺少 itemId', 400);
      if (!requestId) return fail('bad_request', '缺少 requestId（防重复提交的幂等键）', 400);
      if (!qty) return fail('bad_request', `数量必须是 1–${MAX_QTY_PER_RESERVE} 的整数`, 400);

      const event = repo.getActiveEvent();
      if (!event) return fail('no_active_event', '活动还没开始');

      if (!repo.getItem(itemId)) return fail('not_found', MESSAGES.not_found, 404);

      // ★ 取货码由这里生成，撞车了换一个重试。
      //   repository 只负责「撞了要告诉我」，不负责重试——
      //   生成策略是业务决策，不该埋进数据层。
      //   重试时可以放心复用同一个 requestId：失败那次事务已经回滚，
      //   幂等记录没有落库，不会被误判成重放。
      let code = makeCode();
      for (let attempt = 0; attempt < CODE_RETRY; attempt++) {
        const r = repo.tryReserve({
          eventId: event.id, itemId, userId: user.id, qty, requestId, code,
          maxPerUser: maxItemsPerUser,
        });

        if (r.ok) {
          repo.writeAudit({
            actorId: user.id, action: 'reservation.create',
            targetType: 'reservation', targetId: r.reservation.id,
            detail: { itemId, qty, code: r.reservation.code, idempotent: !!r.idempotent },
          });
          return ok({ reservation: r.reservation, remaining: r.remaining ?? null });
        }

        if (r.reason === 'code_taken') { code = makeCode(); continue; }

        // 上限要把具体数字告诉用户，所以不能走静态文案表
        if (r.reason === 'too_many') {
          return fail('too_many',
            `每个账号最多预定 ${r.limit} 件，你已经定了 ${r.current} 件。`, 200);
        }

        const status = r.reason === 'not_found' ? 404 : 200;
        return fail(r.reason, MESSAGES[r.reason] || '预定失败', status);
      }

      return fail('code_taken', MESSAGES.code_taken);
    },

    /* ---------- 取消预定 ---------- */
    cancel({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);

      const reservationId = asId(body?.reservationId);
      if (!reservationId) return fail('bad_request', '缺少 reservationId', 400);

      const existing = repo.getReservation(reservationId);
      if (!existing) return fail('not_found', '预定不存在', 404);
      // 只能取消自己的。这条必须查，不能靠前端不显示按钮。
      if (existing.userId !== user.id) return fail('forbidden', '无权操作他人的预定', 403);

      const r = repo.cancelReservation(reservationId);
      if (!r.ok) {
        return fail(r.reason, MESSAGES.cancelled_reservation || '该预定已无法取消');
      }

      repo.writeAudit({
        actorId: user.id, action: 'reservation.cancel',
        targetType: 'reservation', targetId: reservationId,
        detail: { released: r.released },
      });

      return ok({ released: r.released, reservation: r.reservation });
    },

    /* ---------- 取消别人的预定（管理端） ---------- */
    /**
     * 门槛和改物品一样：deputy 及以上。
     *
     * ★ 复用 repo.cancelReservation，**绝不另写 UPDATE** ——
     *   名额回滚的正确性（只有 reserved → cancelled 那一次成功才加名额，
     *   否则重复点击会让名额虚增）全在它里面，抄一遍必然漏掉。
     */
    adminCancel({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isManager(user)) return fail('forbidden', '你没有管理权限', 403);

      const reservationId = asId(body?.reservationId);
      if (!reservationId) return fail('bad_request', '缺少 reservationId', 400);

      const reason = asReason(body?.reason);
      if (!reason) return fail('bad_request', '请填写取消原因（2–60 个字）', 400);

      const existing = repo.getReservation(reservationId);
      if (!existing) return fail('not_found', '预定不存在', 404);

      const r = repo.cancelReservation(reservationId);
      if (!r.ok) {
        if (r.reason === 'not_found') return fail('not_found', '预定不存在', 404);
        // 已核销的必须明确说"先撤销核销"，否则管理员会以为系统坏了
        if (r.reason === 'redeemed') {
          return fail('already_redeemed', '这条已经核销过了，要取消请先撤销核销');
        }
        if (r.reason === 'cancelled') return fail('cancelled', '这条已经取消过了');
        return fail(r.reason, '取消失败，请重试');
      }

      repo.writeAudit({
        actorId: user.id, action: 'reservation.admin_cancel',
        targetType: 'reservation', targetId: reservationId,
        detail: {
          code: r.reservation.code,
          targetUserId: existing.userId,     // 被取消的是谁，事后要能查
          released: r.released,
          reason,                            // ★ 原因进操作日志
        },
      });

      return ok({ released: r.released, reservation: r.reservation, reason });
    },

    /* ---------- 核销（志愿者） ---------- */
    redeem({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isStaff(user)) return fail('forbidden', '只有志愿者可以核销', 403);

      const code = typeof body?.code === 'string' ? body.code.replace(/\s/g, '') : '';
      if (!/^\d{4,8}$/.test(code)) return fail('bad_request', '取货码格式不对', 400);

      const event = repo.getActiveEvent();
      if (!event) return fail('no_active_event', '活动还没开始');

      const r = repo.redeem(event.id, code, user.id);

      repo.writeAudit({
        actorId: user.id, action: r.ok ? 'reservation.redeem' : 'reservation.redeem_failed',
        targetType: 'reservation', targetId: r.reservation ? r.reservation.id : null,
        detail: { code, result: r.ok ? 'ok' : r.reason },
      });

      if (r.ok) return ok({ reservation: r.reservation });

      if (r.reason === 'invalid') return fail('invalid_code', MESSAGES.invalid_code);
      if (r.reason === 'redeemed') {
        return fail('already_redeemed', MESSAGES.already_redeemed);
      }
      if (r.reason === 'cancelled') return fail('cancelled', MESSAGES.cancelled);
      return fail(r.reason, '核销失败');
    },

    /* ============================================================
       管理端。门槛：deputy 及以上；改角色按 roles.mjs 的策略。
       ============================================================ */

    /** 物品上下架 / 增减名额 */
    adminUpdateItem({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isManager(user)) return fail('forbidden', '你没有管理权限', 403);

      const itemId = asId(body?.itemId);
      if (!itemId) return fail('bad_request', '缺少 itemId', 400);

      const status = body?.status === undefined ? null : body.status;
      if (status !== null && !['on_sale', 'off_shelf'].includes(status)) {
        return fail('bad_request', '状态只能是 on_sale 或 off_shelf', 400);
      }

      let quotaDelta = 0;
      if (body?.quotaDelta !== undefined) {
        quotaDelta = Number(body.quotaDelta);
        if (!Number.isInteger(quotaDelta)) {
          return fail('bad_request', 'quotaDelta 必须是整数', 400);
        }
      }
      if (status === null && quotaDelta === 0) {
        return fail('bad_request', '没有要改的内容', 400);
      }

      const before = repo.getItem(itemId);
      if (!before) return fail('not_found', '物品不存在', 404);

      const r = repo.updateItem({ itemId, status, quotaDelta });
      if (!r.ok) return fail(r.reason, r.message || '改不了', 200);

      repo.writeAudit({
        actorId: user.id, action: 'item.update',
        targetType: 'item', targetId: itemId,
        detail: {
          status: status === null ? undefined : status,
          quotaDelta,
          before: { status: before.status, total: before.totalQuota, remaining: before.remainingQuota },
          after: { status: r.item.status, total: r.item.totalQuota, remaining: r.item.remainingQuota },
        },
      });

      return ok({ item: r.item });
    },

    /** 撤销误核销。门槛比改物品高：只有一级管理员及以上。 */
    adminUndoRedeem({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isSeniorManager(user)) {
        return fail('forbidden', '撤销核销需要一级管理员及以上', 403);
      }

      const reservationId = asId(body?.reservationId);
      if (!reservationId) return fail('bad_request', '缺少 reservationId', 400);

      const r = repo.undoRedeem(reservationId, user.id);
      if (!r.ok) return fail(r.reason, r.message || '撤销失败', r.reason === 'not_found' ? 404 : 200);

      repo.writeAudit({
        actorId: user.id, action: 'reservation.undo_redeem',
        targetType: 'reservation', targetId: reservationId,
        detail: { code: r.reservation.code },
      });

      return ok({ reservation: r.reservation });
    },

    /** 任命 / 撤销管理员。策略全在 roles.mjs。 */
    adminSetRole({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isManager(user)) return fail('forbidden', '你没有管理权限', 403);

      const targetId = asId(body?.userId);
      const nextRole = body?.role;
      if (!targetId) return fail('bad_request', '缺少 userId', 400);
      if (!isRole(nextRole)) return fail('bad_request', '角色不合法', 400);

      const target = repo.findUserById(targetId);
      if (!target) return fail('not_found', '找不到这个人', 404);

      const verdict = checkRoleChange({
        actorRole: user.role, actorId: user.id,
        targetRole: target.role, targetId, nextRole,
      });
      if (!verdict.ok) {
        // 明确的角色是在编造请求，给 403；其余是业务规则不允许
        const status = verdict.reason === 'forbidden' ? 403 : 200;
        return fail(verdict.reason, verdict.message, status);
      }

      const r = repo.setUserRole(targetId, nextRole);
      if (!r.ok) return fail(r.reason, '改不了', 200);

      repo.writeAudit({
        actorId: user.id, action: 'role.change',
        targetType: 'user', targetId,
        detail: { from: r.from, to: r.to },
      });

      return ok({ user: r.user, from: r.from, to: r.to });
    },

    /** 转交超管。换届交接用的，只有超管能做。 */
    adminTransferOwner({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);

      const targetId = asId(body?.userId);
      const verdict = checkOwnerTransfer({
        actorRole: user.role, actorId: user.id, targetId,
      });
      if (!verdict.ok) {
        return fail(verdict.reason, verdict.message, verdict.reason === 'forbidden' ? 403 : 200);
      }

      const r = repo.transferOwnership({ fromUserId: user.id, toUserId: targetId });
      if (!r.ok) return fail(r.reason, '转交失败', 200);

      repo.writeAudit({
        actorId: user.id, action: 'owner.transfer',
        targetType: 'user', targetId,
        detail: { from: r.from.id, to: r.to.id },
      });

      return ok({ from: r.from, to: r.to });
    },

    /** 全量预定名单。format=csv 时导出 CSV，给打印纸质兜底名单用。 */
    adminReservations({ user, query }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isManager(user)) return fail('forbidden', '你没有管理权限', 403);

      const event = repo.getActiveEvent();
      if (!event) return fail('no_active_event', '活动还没开始');

      const status = ['reserved', 'redeemed', 'cancelled'].includes(query?.status)
        ? query.status : null;
      const rows = repo.listEventReservations(event.id, { status });

      if (query?.format === 'csv') {
        return { status: 200, raw: { contentType: 'text/csv; charset=utf-8', text: toCsv(rows) } };
      }
      return ok({ event, total: rows.length, reservations: rows });
    },

    /* ---------- 运行期设置 ---------- */

    /** 读设置。返回值是**生效中**的上限，管理界面直接显示它。 */
    adminGetSettings({ user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isSeniorManager(user)) return fail('forbidden', '改设置需要一级管理员及以上', 403);

      return ok({
        maxItemsPerUser: currentMaxPerUser(),
        // 有没有被管理员改过：没改过时界面显示「默认」，也不显示「恢复默认」按钮
        overridden: repo.getSetting(SETTING_MAX_PER_USER) !== null,
        defaultMaxItemsPerUser: maxItemsPerUser,
        maxAllowed: MAX_ITEMS_PER_USER_LIMIT,
      });
    },

    /**
     * 改设置。`maxItemsPerUser: null` 表示恢复默认（删掉设置行）。
     *
     * ★ 改完**下一笔预定就生效**，不用重启服务 ——
     *   上限是在 repo.tryReserve 的事务里现读的。
     * ★ 调低不会取消已有的预定：已经锁定的名额照旧，只是不能再定新的。
     */
    adminSetSettings({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isSeniorManager(user)) return fail('forbidden', '改设置需要一级管理员及以上', 403);

      if (!Object.prototype.hasOwnProperty.call(body || {}, 'maxItemsPerUser')) {
        return fail('bad_request', '没有要改的内容', 400);
      }

      const before = currentMaxPerUser();
      const raw = body.maxItemsPerUser;

      if (raw === null) {
        repo.clearSetting(SETTING_MAX_PER_USER);
        repo.writeAudit({
          actorId: user.id, action: 'settings.reset',
          targetType: 'setting', targetId: SETTING_MAX_PER_USER,
          detail: { key: SETTING_MAX_PER_USER, from: before, to: maxItemsPerUser, via: 'admin' },
        });
        return ok({ maxItemsPerUser: maxItemsPerUser, overridden: false });
      }

      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > MAX_ITEMS_PER_USER_LIMIT) {
        return fail('bad_request',
          `上限必须是 0–${MAX_ITEMS_PER_USER_LIMIT} 的整数（0 表示不限）`, 400);
      }

      repo.setSetting(SETTING_MAX_PER_USER, n);
      repo.writeAudit({
        actorId: user.id, action: 'settings.update',
        targetType: 'setting', targetId: SETTING_MAX_PER_USER,
        detail: { key: SETTING_MAX_PER_USER, from: before, to: n, via: 'admin' },
      });

      return ok({ maxItemsPerUser: n, overridden: true });
    },
  };
}

/* ============================================================
   名单导出
   ============================================================ */

/** CSV 字段转义：含逗号/引号/换行的要用双引号包起来 */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = ['取货码', '物品', '数量', '取货人', '学号', '状态', '预定时间', '核销时间'];

const STATUS_CN = { reserved: '待取货', redeemed: '已取货', cancelled: '已取消' };

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 导出 CSV。
 *
 * 前面加 BOM 是故意的：不加的话 Excel 打开中文会变乱码，
 * 而这份文件的主要用途就是打印 —— 乱码的名单在现场没法用。
 * 注意表里**没有金额列**，这是硬约束。
 */
export function toCsv(rows) {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push([
      r.code,
      r.itemName,
      r.qty,
      r.userName,
      r.userSid,
      STATUS_CN[r.status] || r.status,
      fmtTime(r.createdAt),
      fmtTime(r.redeemedAt),
    ].map(csvCell).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
