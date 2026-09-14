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
import { generateCode } from './repository.mjs';

export const API_VERSION = '1.0.0';

/** 单次预定的数量上限。防止有人一次把名额全占了。 */
export const MAX_QTY_PER_RESERVE = 5;
/** 取货码撞车后的重试次数。6 位数字空间很大，撞一次都算罕见。 */
export const CODE_RETRY = 5;

const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } });
const fail = (error, message, status = 200) => ({ status, body: { ok: false, error, message } });

const isStaff = (user) => !!user && ['volunteer', 'admin', 'owner'].includes(user.role);

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
  const asName = (v) => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s.length >= 2 && s.length <= 12 ? s : null;
  };

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
      const sid = asSid(body?.sid);
      const name = asName(body?.name);
      if (!sid) return fail('bad_request', '请输入 6–16 位数字学号', 400);
      if (!name) return fail('bad_request', '请输入真实姓名', 400);

      const r = repo.createUser({ openid: auth.openid, sid, name, role: 'student' });
      if (!r.ok) {
        return fail(r.reason, MESSAGES[r.reason] || '登记失败');
      }

      repo.writeAudit({
        actorId: r.user.id, action: 'user.register',
        targetType: 'user', targetId: r.user.id,
        detail: { sid },
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
  };
}
