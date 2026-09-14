/**
 * 后端接口客户端。
 *
 * ★ 这里刻意不依赖任何页面、也不碰 storage —— 只负责「发请求、翻译结果」。
 *   会话管理在 session.js，两者不互相引用，避免循环依赖。
 *
 * 错误约定（与 docs/api.md 一致）：
 *   - 200 + ok:true          → 正常返回 data
 *   - 200 + ok:false         → 抛 ApiError，business = true
 *                              （约满、重复预定这类，直接把 message 弹给用户）
 *   - 4xx / 5xx              → 抛 ApiError，business = false
 *   - 网络失败 / 超时        → 抛 ApiError，code = 'network'
 *
 * 页面只要 catch 住 ApiError，看 e.message 就能直接展示，不用自己拼文案。
 */
import { BASE_URL, REQUEST_TIMEOUT } from '../config.js';
import { platform } from './platform.js';

export class ApiError extends Error {
  constructor(code, message, { status = 0, business = false, retryAfter = 0 } = {}) {
    super(message || '出错了');
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.business = business;
    this.retryAfter = retryAfter;
  }
}

/** 拿不到服务端文案时的兜底 */
const FALLBACK = {
  network: '网络不太好，请重试一下',
  timeout: '网络有点慢，请重试一下',
  unauthorized: '登录状态已过期，请重新进入小程序',
  forbidden: '你没有权限做这个操作',
  rate_limited: '操作太频繁了，缓一缓再试',
  not_found: '内容不存在',
  method_not_allowed: '请求方式不对（这是前端 bug）',
  payload_too_large: '请求内容过大',
  internal: '服务出错了，请稍后再试',
  bad_request: '请求参数不对',
};

function statusToCode(status) {
  switch (status) {
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 405: return 'method_not_allowed';
    case 413: return 'payload_too_large';
    case 429: return 'rate_limited';
    default: return status >= 500 ? 'internal' : 'bad_request';
  }
}

/**
 * 发一个请求。
 * @param {'GET'|'POST'} method
 * @param {string} path          形如 '/api/items'
 * @param {object} [opts]
 * @param {object} [opts.body]
 * @param {string} [opts.token]
 */
export async function request(method, path, { body, token } = {}) {
  const header = { 'content-type': 'application/json' };
  if (token) header.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await platform().request({
      url: BASE_URL + path,
      method,
      data: body,
      header,
      timeout: REQUEST_TIMEOUT,
    });
  } catch (e) {
    const msg = String((e && e.errMsg) || '');
    const code = /timeout/i.test(msg) ? 'timeout' : 'network';
    throw new ApiError(code, FALLBACK[code]);
  }

  const status = res.statusCode;
  const data = res.data;

  // 中间的代理（nginx）出问题时可能返回 HTML，这里要兜住
  if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') {
    throw new ApiError('internal', FALLBACK.internal, { status });
  }

  if (status === 200 && data.ok) return data;

  if (status === 200 && data.ok === false) {
    // 业务失败：服务端已经给了给人看的文案，直接用
    throw new ApiError(data.error || 'business', data.message || '操作没成功', {
      status, business: true,
    });
  }

  const code = statusToCode(status);
  throw new ApiError(code, data.message || FALLBACK[code] || FALLBACK.internal, {
    status,
    retryAfter: Number((res.header && res.header['Retry-After']) || 0),
  });
}

export const get = (path, opts) => request('GET', path, opts);
export const post = (path, opts) => request('POST', path, opts);

/**
 * 生成幂等键。
 * 小程序里没有 crypto.randomUUID，用时间戳 + 随机数就够了 ——
 * 它只需要「同一个客户端不重复」，不需要全局唯一。
 */
export function genRequestId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
