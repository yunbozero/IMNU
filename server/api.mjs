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
import { parseEventTime, checkRange, formatEventTime } from './time.mjs';
import {
  saveImage, deleteImage, imageExists, imageUrlOf,
  MAX_IMAGE_BYTES, MAX_IMAGE_BASE64, PROD_IMAGE_DIR,
} from './images.mjs';
import {
  ROLE_LABEL, isRole, canManage, canRedeem, canAdminister,
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

/**
 * 新建物品时的字数/数量上限。
 *
 * ★ 这几个数字小程序那边也有一份（packageAdmin/utils/item-form.js），
 *   由 tests/miniprogram.test.mjs 逐个比对 —— 两边不一致的话，
 *   界面会先把人放过去再被服务端拒掉，报错出在提交那一刻，很难查。
 */
export const ITEM_NAME_MAX = 20;
export const ITEM_DESC_MAX = 40;
/** 单个物品的名额上限。义卖的量级是几十件，9999 纯粹是拦「多打了一位」。 */
export const ITEM_QUOTA_MAX = 9999;
/**
 * 图标最多几个字。
 * 按**码点**数而不是 JS 的 length：'🍪'.length 是 2（代理对），
 * 拿 length 当上限的话一个 emoji 就把两个字的位置占满了。
 */
export const ITEM_EMOJI_MAX = 2;

/** 场次名字与摊位名字的字数上限 */
export const EVENT_NAME_MAX = 40;
export const STALL_NAME_MAX = 30;
export const STALL_LOC_MAX = 40;

/** 场次的三个状态。和 server/db.mjs 里注释写的、以及 init-event.mjs 用的保持一致。 */
export const EVENT_STATUSES = ['draft', 'on_sale', 'ended'];

/**
 * 物品状态。
 * ★ `deleted` 是**软删除**：行还在，只是从学生端和物品列表里消失。
 *   不真删行，是因为预定记录通过外键指向物品 —— 真删了，
 *   名单上「物品名」那一列会变空，学生定过的东西现场查不出来。
 *   `off_shelf`（下架）和它不同：下架只是不能预定，学生**还看得到**（灰掉）。
 */
export const ITEM_STATUSES = ['on_sale', 'off_shelf', 'deleted'];

/** 图片太大时的提示。抽出来是因为它出现在两个地方，措辞必须一致。 */
const TOO_BIG_MSG = `图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024)}KB，请压缩后再传`;

/**
 * 物品图标可用的底色。
 * ★ 必须和 miniprogram/app.wxss 里的 .t-* 类一一对应，否则小程序会渲染成
 *   没有底色的白块 —— 不报错，只是难看，所以交给测试守着。
 */
export const ITEM_TINTS = ['t-pink', 't-green', 't-blue', 't-yellow', 't-purple', 't-orange'];

const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } });
const fail = (error, message, status = 200) => ({ status, body: { ok: false, error, message } });

const isStaff = (user) => !!user && canRedeem(user.role);
const isManager = (user) => !!user && canManage(user.role);
/**
 * 一级管理员及以上（副主任管理员不算）。
 * 用于「撤销核销」「改运行期设置」「建/结束活动」—— 这几件事的影响面比改单个物品大。
 * ★ 规则住在 roles.mjs 的 canAdminister 里，这里只是套上「是不是登录用户」。
 */
const isSeniorManager = (user) => isManager(user) && canAdminister(user.role);

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
  imageDir = PROD_IMAGE_DIR,    // 物品照片存在哪
  wxConfigured = true,          // 服务端配了小程序密钥没有（只用于健康检查和报错文案）
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

  /** 物品名。列表里一件一行，太长会折行把页面撑乱。 */
  const asItemName = (v) => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s.length >= 1 && s.length <= ITEM_NAME_MAX ? s : null;
  };

  /** 场次名。同一个道理：太长了在列表和首页上都会折行。 */
  const asEventName = (v) => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s.length >= 1 && s.length <= EVENT_NAME_MAX ? s : null;
  };

  /** 摊位名。 */
  const asStallName = (v) => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s.length >= 1 && s.length <= STALL_NAME_MAX ? s : null;
  };

  /** 可选的短文本（简介 / 图标）：没填就是 null，填了超长才报错。 */
  const asOptionalText = (v, max) => {
    if (v === undefined || v === null || v === '') return { ok: true, value: null };
    if (typeof v !== 'string') return { ok: false };
    const s = v.trim();
    if ([...s].length > max) return { ok: false };
    return { ok: true, value: s || null };
  };

  /**
   * 物品照片。三态：不传（undefined）= 不动；null / '' = 清掉；文件名 = 换成它。
   *
   * 传的必须是**上传接口返回的那个文件名**，不是路径也不是 URL ——
   * 文件名由服务端生成（`img_<32位十六进制>.<扩展名>`），所以拼路径不可能跑出目录。
   * 而且**只有文件真的在磁盘上才收**：库里存了名字但文件不在的话，
   * 界面会显示一个破图标，还不会回落到 emoji（判断「有没有图」看的就是这个名字）。
   */
  const asStoredImage = (v) => {
    if (v === undefined) return { ok: true, value: undefined };
    if (v === null || v === '') return { ok: true, value: null };
    if (!imageExists(v, imageDir)) return { ok: false };
    return { ok: true, value: v };
  };

  /**
   * 图鉴里一只猫的 id 长什么样。
   *
   * ★ 和 miniprogram/data/cats.js 里的 id 必须对得上，但**不 import 那个文件** ——
   *   server/ 一旦依赖 miniprogram/ 就不能单独跑了（现在它可以是自足的）。
   *   本仓库对这类「两边都需要的知识」的做法是各存一份 + 一条漂移测试，
   *   tests/miniprogram.test.mjs 里那条会拿 CATS 的真实 id 来过这个正则。
   */
  const CAT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

  /** 覆盖用的照片只能是**上传接口产出的**文件名，不能是仓库里那张 cats/xxx.jpg。 */
  const isUploadedImage = (name) => typeof name === 'string' && name.startsWith('img_');

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
        // ★ 有没有配小程序密钥。只报真假，不报任何密钥内容。
        //
        //   为什么值得对外说：没配的话**每个人**都登录不了，而客户端只能显示
        //   「微信登录失败」—— 看起来像网络问题或代码 bug，排查方向全错。
        //   一条 curl 就能分清「服务器没配好」和「网络/域名不通」。
        wxConfigured,
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
        // ★ 「服务端没配 AppID/AppSecret」和「code 无效」在客户端看起来一模一样，
        //   但排查方向完全相反：前者要去服务器填配置，后者只是正常的过期 code。
        //   这里把前者显式区分出来 —— 但**不把微信的原始报错透给前端**，
        //   那里面可能带着 appid。
        const notConfigured = !wxConfigured || /未配置 WX_APPID/.test(String(e && e.message));
        if (notConfigured) {
          return fail('wx_not_configured',
            '服务端还没配置小程序密钥，请联系管理员', 401);
        }
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
          image: it ? it.image : null,
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
       管理端 · 活动与摊位

       为什么现在有界面入口了：以前建活动 / 摊位只能 SSH 上去改 JSON 再跑脚本。
       对「一年做一两次」本来可以忍，但组织者手上未必有 SSH ——
       换届之后那条命令谁来敲？所以补上。
       ★ 只有「设立第一个超管」必须走命令行（不能让任何人在界面上把自己设成超管）。
       ============================================================ */

    /** 列出全部场次，含已结束的。管理端要用它看历史、收尾旧活动。 */
    adminListEvents({ user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isSeniorManager(user)) {
        return fail('forbidden', '看活动列表需要一级管理员及以上', 403);
      }

      return ok({
        events: repo.listEvents().map((e) => ({
          ...e,
          startsAtText: formatEventTime(e.startsAt),
          endsAtText: formatEventTime(e.endsAt),
          active: e.status === 'on_sale',
        })),
      });
    },

    /**
     * 新建场次。**一级管理员及以上** ——
     * 它决定全场看到什么，和「撤销核销」「改每账号上限」是同一量级的事。
     *
     * ★ 同时只能有一个「在售」场次。已经有一个在售时：
     *     不传 endPrevious → 返回 event_conflict（界面据此问「要先把旧的结束掉吗」）
     *     传了 endPrevious → 把旧的那个结束掉，再建这个
     *   之所以不静默地让两个并存：`getActiveEvent` 只认最新的那个，
     *   于是首页显示的是新的、而管理端看着有两个 —— 排查起来很费劲。
     */
    adminCreateEvent({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isSeniorManager(user)) {
        return fail('forbidden', '建活动需要一级管理员及以上', 403);
      }

      const name = asEventName(body?.name);
      if (!name) return fail('bad_request', `活动名要填 1–${EVENT_NAME_MAX} 个字`, 400);

      let startsAt;
      let endsAt;
      try {
        startsAt = parseEventTime(body?.startsAt, '开始时间');
        endsAt = parseEventTime(body?.endsAt, '结束时间');
        checkRange(startsAt, endsAt);
      } catch (e) {
        return fail('bad_request', e.message, 400);
      }

      const draft = body?.draft === true;

      let endedPrevious = null;
      if (!draft) {
        const active = repo.getActiveEvent();
        if (active) {
          if (body?.endPrevious !== true) {
            return fail('event_conflict',
              `现在已经在售「${active.name}」。要开始新的，请先把旧的结束掉。`);
          }
          repo.updateEventStatus(active.id, 'ended');
          endedPrevious = active;
        }
      }

      const event = repo.createEvent({
        name, startsAt, endsAt, status: draft ? 'draft' : 'on_sale',
      });

      repo.writeAudit({
        actorId: user.id, action: 'event.create',
        targetType: 'event', targetId: event.id,
        detail: { name, draft, endedPrevious: endedPrevious ? endedPrevious.id : null },
      });
      if (endedPrevious) {
        repo.writeAudit({
          actorId: user.id, action: 'event.end',
          targetType: 'event', targetId: endedPrevious.id,
          detail: { name: endedPrevious.name, reason: '新建活动时顺带结束', via: 'admin' },
        });
      }

      return ok({ event, endedPrevious });
    },

    /** 改场次状态：开售 / 收尾（结束）/ 退回草稿。一级管理员及以上。 */
    adminSetEventStatus({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isSeniorManager(user)) {
        return fail('forbidden', '改活动状态需要一级管理员及以上', 403);
      }

      const eventId = asId(body?.eventId);
      if (!eventId) return fail('bad_request', '缺少 eventId', 400);

      const status = body?.status;
      if (!EVENT_STATUSES.includes(status)) {
        return fail('bad_request', `状态只能是 ${EVENT_STATUSES.join(' / ')}`, 400);
      }

      const target = repo.listEvents().find((e) => e.id === eventId);
      if (!target) return fail('not_found', '活动不存在', 404);

      // 同一个不变量：至多一个在售。★ 要排除它自己，否则「重复设成在售」会被自己挡住。
      if (status === 'on_sale') {
        const active = repo.getActiveEvent();
        if (active && active.id !== eventId) {
          return fail('event_conflict',
            `「${active.name}」还在售。要开始这个，请先把那个结束掉。`);
        }
      }

      if (target.status === status) {
        return ok({ event: target, unchanged: true });
      }

      const r = repo.updateEventStatus(eventId, status);
      if (!r.ok) return fail(r.reason, '改不了', 404);

      repo.writeAudit({
        actorId: user.id, action: 'event.status',
        targetType: 'event', targetId: eventId,
        detail: { name: target.name, from: target.status, to: status },
      });

      return ok({ event: r.event });
    },

    /**
     * 新建摊位。**副主任管理员及以上**（和建/改物品同一档）——
     * 摊位是内容，不是全场开关，没必要抬到一级管理员。
     *
     * 摊位挂在**当前在售的活动**下。没有在售活动时直接说清楚 ——
     * 挂在草稿活动下的摊位谁也看不到，与其让它变成一个查不到的孤儿，
     * 不如告诉管理员先把活动开起来。
     */
    adminCreateStall({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isManager(user)) return fail('forbidden', '你没有管理权限', 403);

      const event = repo.getActiveEvent();
      if (!event) {
        return fail('no_active_event', '还没有在售的活动，先在「活动与摊位」里建一个');
      }

      const name = asStallName(body?.name);
      if (!name) return fail('bad_request', `摊位名要填 1–${STALL_NAME_MAX} 个字`, 400);

      const loc = asOptionalText(body?.loc, STALL_LOC_MAX);
      if (!loc.ok) return fail('bad_request', `位置最多 ${STALL_LOC_MAX} 个字`, 400);

      // 同名摊位会让「这堆东西在哪个摊」变得含糊，而且列表里两条长得一样
      if (repo.listStalls(event.id).some((s) => s.name === name)) {
        return fail('stall_exists', `这次活动里已经有一个叫「${name}」的摊位了`);
      }

      const stall = repo.createStall({ eventId: event.id, name, loc: loc.value });

      repo.writeAudit({
        actorId: user.id, action: 'stall.create',
        targetType: 'stall', targetId: stall.id,
        detail: { name, loc: loc.value, eventId: event.id },
      });

      return ok({ stall });
    },

    /* ============================================================
       管理端。门槛：deputy 及以上；改角色按 roles.mjs 的策略。
       ============================================================ */

    /** 物品上下架 / 增减名额 / 换图 / 软删除 */
    adminUpdateItem({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isManager(user)) return fail('forbidden', '你没有管理权限', 403);

      const itemId = asId(body?.itemId);
      if (!itemId) return fail('bad_request', '缺少 itemId', 400);

      const status = body?.status === undefined ? null : body.status;
      if (status !== null && !ITEM_STATUSES.includes(status)) {
        return fail('bad_request', `状态只能是 ${ITEM_STATUSES.join(' / ')}`, 400);
      }

      let quotaDelta = 0;
      if (body?.quotaDelta !== undefined) {
        quotaDelta = Number(body.quotaDelta);
        if (!Number.isInteger(quotaDelta)) {
          return fail('bad_request', 'quotaDelta 必须是整数', 400);
        }
      }
      // 换图 / 清空图片。三态由 asStoredImage 负责区分（见它的注释）。
      const image = asStoredImage(body?.image);
      if (!image.ok) return fail('bad_request', '图片不存在，请重新上传', 400);

      if (status === null && quotaDelta === 0 && image.value === undefined) {
        return fail('bad_request', '没有要改的内容', 400);
      }

      const before = repo.getItem(itemId);
      if (!before) return fail('not_found', '物品不存在', 404);

      // ★ 还有待取货的预定时不许删。
      //   「学生定好了、东西却从列表里消失」是最让人懵的一种状态；
      //   正确的处理是先取消那几笔（管理端能取消，还得填原因），再删。
      //   已经核销过的不管 —— 那笔交易已经完成，删物品不影响它。
      if (status === 'deleted' && before.status !== 'deleted') {
        const pending = repo.listEventReservations(before.eventId, { status: 'reserved' })
          .filter((r) => r.itemId === itemId);
        if (pending.length > 0) {
          return fail('item_has_pending',
            `还有 ${pending.length} 笔待取货的预定，先取消它们再删 —— `
            + '不然学生定好的东西会从列表里凭空消失。');
        }
      }

      const r = repo.updateItem({ itemId, status, quotaDelta, image: image.value });
      if (!r.ok) return fail(r.reason, r.message || '改不了', 200);

      // 换掉或清掉之后，旧文件就成了没人引用的垃圾。
      // ★ 只在**确实变了**的时候删 —— 而且放在数据改完之后：
      //   万一删文件失败，也不会把「数据库已经改好」这件事回滚掉。
      if (before.image && before.image !== r.item.image) deleteImage(before.image, imageDir);

      repo.writeAudit({
        actorId: user.id, action: 'item.update',
        targetType: 'item', targetId: itemId,
        detail: {
          status: status === null ? undefined : status,
          quotaDelta,
          image: image.value === undefined ? undefined : r.item.image,
          before: {
            status: before.status, total: before.totalQuota,
            remaining: before.remainingQuota, image: before.image,
          },
          after: {
            status: r.item.status, total: r.item.totalQuota,
            remaining: r.item.remainingQuota, image: r.item.image,
          },
        },
      });

      return ok({ item: r.item });
    },

    /**
     * 上传一张物品照片。门槛和建/改物品一致（deputy 及以上）。
     *
     * ★ 为什么走 base64 的 JSON，而不是 multipart：
     *   multipart 要在零依赖的前提下自己解析边界字符串、CRLF、分块和文件名编码 ——
     *   那是整条上传链路里唯一真正麻烦的部分。走 base64 就只剩
     *   `Buffer.from(s, 'base64')` 一行。代价是体积大 1/3，而图片在客户端已经
     *   压到 100–300KB，这点代价可以忽略。
     *
     * ★ 类型只看**魔术字节**，不看客户端声明的 content-type —— 后者客户端说了算，
     *   把 .exe 改名成 .jpg 就能骗过去。
     * ★ `Buffer.from(..., 'base64')` 对非法字符是**静默跳过**、不抛错，
     *   所以「能解码」完全不等于「是图片」，魔术字节那一步不能省。
     */
    adminUploadImage({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isManager(user)) return fail('forbidden', '你没有管理权限', 403);

      const raw = body?.image;
      if (typeof raw !== 'string' || raw === '') {
        return fail('bad_request', '缺少图片数据', 400);
      }

      // 容忍 data:image/jpeg;base64,xxx 这种前缀（有些前端库会带上）
      const b64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;

      // 先按字符串长度拦一道：解码前就知道超没超，不必先把它吃进内存
      if (b64.length > MAX_IMAGE_BASE64) return fail('too_large', TOO_BIG_MSG, 413);

      const saved = saveImage(Buffer.from(b64, 'base64'), imageDir);

      if (!saved.ok) {
        if (saved.reason === 'too_large') return fail('too_large', TOO_BIG_MSG, 413);
        if (saved.reason === 'empty') return fail('bad_request', '图片是空的', 400);
        // 认不出类型时把「支持哪些」直接写出来，省一轮来回
        return fail('not_image', '只支持 JPG / PNG / WebP / GIF 图片', 400);
      }

      repo.writeAudit({
        actorId: user.id, action: 'image.upload',
        targetType: 'image', targetId: saved.name,
        detail: { bytes: saved.bytes, mime: saved.mime },
      });

      return ok({ image: saved.name, url: imageUrlOf(saved.name), bytes: saved.bytes });
    },

    /**
     * 图鉴照片的覆盖表。**公开**，不需要登录。
     *
     * 为什么公开：图鉴是 tabBar 上的一级页面，任何人打开都要能看到照片；
     * 而且它本来就不是秘密（仓库里那份是公开的内容）。返回的只是一张
     * 「哪只猫换了哪张图」的表，没有用户信息。
     *
     * 客户端拿到之后和 cats.js 里的 image 合并：**有覆盖就用覆盖，
     * 没有就用仓库里那张**。请求失败时客户端继续用仓库那张，所以断网也能看图鉴。
     */
    listCatPhotos() {
      const photos = {};
      for (const r of repo.listCatPhotos()) photos[r.catId] = r.image;
      return ok({ photos });
    },

    /**
     * 给某只猫换照片（副主任及以上，和物品照片同一档）。
     *
     * body: { catId, image }，image 必须是上传接口返回的文件名；
     * 传 null / '' 表示**恢复成仓库里那张**（删掉覆盖行，而不是存个空值）。
     *
     * ★ 换图之后要把旧的**上传文件**删掉，否则每换一次就在磁盘上留一张
     *   谁也不引用的图，一年下来能攒出几百兆。
     *   但绝不能删 `cats/xxx.jpg` —— 那是仓库同步过来的默认照片，
     *   删掉等于把兜底也弄没了（而且下次发布又会同步回来，只是中间那段时间 404）。
     */
    adminSetCatPhoto({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isManager(user)) return fail('forbidden', '你没有管理权限', 403);

      const catId = typeof body?.catId === 'string' ? body.catId.trim() : '';
      if (!CAT_ID_RE.test(catId)) return fail('bad_request', '不认识的猫', 400);

      const before = repo.listCatPhotos().find((p) => p.catId === catId) || null;

      // 清空：删覆盖行，回落到仓库里那张
      if (body?.image === null || body?.image === '') {
        if (!before) return ok({ catId, image: null, cleared: false });

        repo.clearCatPhoto(catId);
        if (isUploadedImage(before.image)) deleteImage(before.image, imageDir);
        repo.writeAudit({
          actorId: user.id, action: 'cat_photo.clear',
          targetType: 'cat', targetId: catId, detail: { image: before.image },
        });
        return ok({ catId, image: null, cleared: true });
      }

      const image = asStoredImage(body?.image);
      if (!image.ok) return fail('bad_request', '图片不存在，请重新上传', 400);
      if (image.value === undefined || image.value === null) {
        return fail('bad_request', '缺少图片', 400);
      }

      // ★ 覆盖值必须是**上传接口产出的**文件名（img_<hex>.jpg）。
      //   仓库里那张（cats/xxx.jpg）是兜底，不能当覆盖写进来：
      //     · 写进去之后「恢复默认」就没了意义 —— 它和默认值一模一样；
      //     · 仓库那边换图时，这一行还指着旧文件名，谁也看不出是为什么。
      //   想用仓库那张就传 null（= 删掉覆盖），语义只有这一条。
      if (!isUploadedImage(image.value)) {
        return fail('bad_request', '请重新上传一张照片，不能直接把默认照片设成覆盖', 400);
      }

      repo.setCatPhoto({ catId, image: image.value, actorId: user.id });

      // 换了另一张上传图才删旧的；设置成同一张时什么都不动
      if (before && before.image !== image.value && isUploadedImage(before.image)) {
        deleteImage(before.image, imageDir);
      }

      repo.writeAudit({
        actorId: user.id, action: 'cat_photo.set',
        targetType: 'cat', targetId: catId,
        detail: { image: image.value, replaced: before ? before.image : null },
      });

      return ok({ catId, image: image.value, replaced: before ? before.image : null });
    },

    /**
     * 新建物品。
     *
     * 为什么要有：义卖当天现场「这东西也拿来卖」是常态，而在此之前
     * 往库里加物品的唯一办法是登上服务器跑脚本 —— 组织者是没有 SSH 的。
     *
     * 门槛和改物品一致（deputy 及以上）：这是同一类「维护物品清单」的动作，
     * 分两档只会让志愿者在当天找不到人开权限。
     *
     * ★ 物品一律建成在售。想先藏着就别建；建完想撤就下架（改物品那条路）。
     *   多一个「草稿」状态意味着多一种「为什么学生看不到」的排查成本。
     */
    adminCreateItem({ body, user }) {
      if (!user) return fail('unauthorized', '请先登录', 401);
      if (!isManager(user)) return fail('forbidden', '你没有管理权限', 403);

      // 物品必须挂在某个场次下。没有在售场次时建出来的物品谁也看不见，
      // 与其让它变成一个查不到的孤儿，不如告诉管理员先去把活动开起来。
      const event = repo.getActiveEvent();
      if (!event) {
        return fail('no_active_event', '还没有在售的活动，先跑 scripts/init-event.mjs 把活动建起来');
      }

      const name = asItemName(body?.name);
      if (!name) return fail('bad_request', `物品名要填 1–${ITEM_NAME_MAX} 个字`, 400);

      // 数字或数字字符串都收（界面那边输入框给的是字符串）。
      // ★ 不用裸 Number(v)：Number(true) 是 1、Number([]) 是 0，
      //   会把明显不是数量的东西悄悄变成一个合法值。
      const rawQuota = typeof body?.totalQuota === 'string'
        ? Number(body.totalQuota.trim())
        : body?.totalQuota;
      if (!Number.isInteger(rawQuota) || rawQuota < 1 || rawQuota > ITEM_QUOTA_MAX) {
        return fail('bad_request', `名额要是 1–${ITEM_QUOTA_MAX} 的整数`, 400);
      }

      const desc = asOptionalText(body?.description, ITEM_DESC_MAX);
      if (!desc.ok) return fail('bad_request', `简介最多 ${ITEM_DESC_MAX} 个字`, 400);

      const emoji = asOptionalText(body?.emoji, ITEM_EMOJI_MAX);
      if (!emoji.ok) return fail('bad_request', `图标最多 ${ITEM_EMOJI_MAX} 个字（一个 emoji 算一个）`, 400);

      const tint = body?.tint === undefined || body?.tint === null || body?.tint === ''
        ? ITEM_TINTS[0]
        : body.tint;
      if (!ITEM_TINTS.includes(tint)) {
        return fail('bad_request', `配色只能是 ${ITEM_TINTS.join(' / ')}`, 400);
      }

      // ★ 摊位必须在**本次活动的**摊位里。
      //   不校验的话，一个乱填的 id 会让物品的 stall_id 指向别的场次甚至不存在的行，
      //   症状是「管理端看着有摊位、学生那头显示未分配」，而且删活动时会撞外键。
      let stallId = null;
      if (body?.stallId !== undefined && body?.stallId !== null && body?.stallId !== '') {
        stallId = asId(body.stallId);
        if (!stallId) return fail('bad_request', '摊位 id 不合法', 400);
        if (!repo.listStalls(event.id).some((s) => s.id === stallId)) {
          return fail('bad_request', '这个摊位不属于当前活动', 400);
        }
      }

      // 照片是可选的：没传就是没有，界面回落到 emoji + 底色
      const image = asStoredImage(body?.image);
      if (!image.ok) return fail('bad_request', '图片不存在，请重新上传', 400);

      const item = repo.createItem({
        eventId: event.id, stallId,
        name, description: desc.value, emoji: emoji.value, tint,
        image: image.value === undefined ? null : image.value,
        totalQuota: rawQuota, status: 'on_sale',
      });

      repo.writeAudit({
        actorId: user.id, action: 'item.create',
        targetType: 'item', targetId: item.id,
        detail: { name, totalQuota: rawQuota, stallId, image: item.image, via: 'admin' },
      });

      return ok({ item });
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
