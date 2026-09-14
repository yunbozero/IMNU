/**
 * 鉴权。
 *
 * ★ 迁到云开发时，这个文件基本整层删掉：
 *   云函数里 `cloud.getWXContext().OPENID` 是天然可信的，不需要自己签发和
 *   校验 token，也不需要保存 appSecret。
 *
 * 但在自建方案里这一层必须自己写：
 *   小程序 `wx.login()` 拿到 code → 后端拿 code + AppSecret 去微信换 openid
 *   → 签发一个 token 给小程序 → 之后每个请求带这个 token。
 *
 * AppSecret 只在服务端出现，绝不能下发到小程序。
 */
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/* ============================================================
   Token
   ============================================================ */

/**
 * 签发 token。结构是 `base64url(payload).base64url(hmac)`，
 * 语义上是个极简的 JWT —— 不引第三方库，因为只需要签名和过期。
 */
export function signToken(payload, secret, ttlMs = 7 * 24 * 3600 * 1000) {
  if (!secret) throw new Error('签发 token 需要 secret');
  const body = { ...payload, exp: Date.now() + ttlMs, jti: randomUUID() };
  const data = b64u(JSON.stringify(body));
  const sig = b64u(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

/** 校验 token。任何一步不对都返回 null，不抛异常。 */
export function verifyToken(token, secret) {
  if (!secret) return null;
  if (typeof token !== 'string') return null;

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64u(createHmac('sha256', secret).update(data).digest());

  // 定长比较，避免通过响应时间猜签名
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  try {
    const body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (typeof body.exp !== 'number' || body.exp < Date.now()) return null;

    // 两种 token 的「身份锚点」不一样，不能一律要求 uid：
    //   scope=user      —— 已经登记的人，必须有 uid
    //   scope=register  —— 只登录还没登记，uid 本来就是 null，靠 openid 认人
    if (body.scope === 'register') {
      return typeof body.openid === 'string' && body.openid ? body : null;
    }

    return body.uid ? body : null;
  } catch {
    return null;
  }
}

export const parseBearer = (header) =>
  typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : null;

/* ============================================================
   code2session
   ============================================================ */

export const WECHAT_SESSION_ENDPOINT = 'https://api.weixin.qq.com/sns/jscode2session';

/**
 * 用微信官方接口把 code 换成 openid。
 *
 * fetchImpl 可注入，测试时不需要联网，也不会碰到真的 AppSecret。
 */
export function createWechatSessionProvider({ appId, appSecret, fetchImpl = globalThis.fetch }) {
  if (!appId || !appSecret) {
    throw new Error('缺少 WX_APPID / WX_SECRET：自建方案必须配置小程序密钥才能换 openid');
  }

  return {
    async exchange(code) {
      const url = `${WECHAT_SESSION_ENDPOINT}` +
        `?appid=${encodeURIComponent(appId)}` +
        `&secret=${encodeURIComponent(appSecret)}` +
        `&js_code=${encodeURIComponent(code)}` +
        `&grant_type=authorization_code`;

      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`code2session 网络错误：HTTP ${res.status}`);

      const data = await res.json();

      // 微信的失败是 200 + errcode，不是 HTTP 错误码，必须自己判断
      if (!data || !data.openid) {
        throw new Error(`code2session 失败：${data && data.errcode} ${data && data.errmsg}`);
      }

      return {
        openid: data.openid,
        unionid: data.unionid || null,
        sessionKey: data.session_key || null,
      };
    },
  };
}

/**
 * 测试用：把 code 直接映射成 openid。
 * 有了它，整个 API 都能在没有小程序账号、没有网络的情况下端到端测试。
 */
export function createFakeSessionProvider(map = {}) {
  return {
    async exchange(code) {
      if (typeof code !== 'string' || !code) throw new Error('code 不合法');
      return {
        openid: Object.prototype.hasOwnProperty.call(map, code) ? map[code] : `openid:${code}`,
        unionid: null,
        sessionKey: 'fake-session-key',
      };
    },
  };
}

/* ============================================================
   限流
   ============================================================ */

/**
 * 按 key 计数的滑动窗口限流。
 * 义卖当天是短时高并发，防的不是黑客，是「有人写脚本刷名额」。
 */
export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();

  return {
    /** @returns {{ok: true, remaining: number} | {ok: false, retryAfterMs: number}} */
    check(key) {
      const t = now();
      const cutoff = t - windowMs;
      const list = (hits.get(key) || []).filter((ts) => ts > cutoff);

      if (list.length >= limit) {
        hits.set(key, list);
        return { ok: false, retryAfterMs: list[0] + windowMs - t };
      }

      list.push(t);
      hits.set(key, list);
      return { ok: true, remaining: limit - list.length };
    },

    reset() { hits.clear(); },
    get size() { return hits.size; },
  };
}
