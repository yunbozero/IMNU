/**
 * 会话管理：token 与当前用户。
 *
 * 两种 token 的处理方式不同，别混：
 *   scope=register —— 登录了但还没登记学号姓名。存在 storage 里，
 *                     供登记页使用；此时 getUser() 仍然是 null。
 *   scope=user     —— 正式用户。getUser() 有值。
 */
import * as api from './api.js';
import { platform } from './platform.js';

const TOKEN_KEY = 'bz:token';
const SCOPE_KEY = 'bz:scope';
const USER_KEY = 'bz:user';

let cachedUser = null;
let cachedLoaded = false;

function loadUser() {
  if (!cachedLoaded) {
    cachedUser = platform().getStorage(USER_KEY);
    cachedLoaded = true;
  }
  return cachedUser;
}

function saveSession({ token, scope, user }) {
  if (token) platform().setStorage(TOKEN_KEY, token);
  platform().setStorage(SCOPE_KEY, scope || 'user');

  if (user) {
    cachedUser = user;
    cachedLoaded = true;
    platform().setStorage(USER_KEY, user);
  } else {
    cachedUser = null;
    cachedLoaded = true;
    platform().removeStorage(USER_KEY);
  }
}

export const getToken = () => platform().getStorage(TOKEN_KEY);
export const getScope = () => platform().getStorage(SCOPE_KEY);
export const getUser = () => loadUser();

/** 志愿者/管理员才看得到核销入口。注意这只是界面控制，真正的权限在服务端。 */
export function isStaff() {
  const u = loadUser();
  return !!u && ['volunteer', 'admin', 'owner'].includes(u.role);
}

export function clearSession() {
  platform().removeStorage(TOKEN_KEY);
  platform().removeStorage(SCOPE_KEY);
  platform().removeStorage(USER_KEY);
  cachedUser = null;
  cachedLoaded = true;
}

/** 只有测试会用到：把缓存清掉，强制下次重新读 storage */
export function resetCache() {
  cachedUser = null;
  cachedLoaded = false;
}

/**
 * 走一遍 wx.login → /api/login。
 * 该登记还是已登记都能调，返回 { registered, user }。
 */
export async function login() {
  const res = await platform().login();
  if (!res || !res.code) throw new api.ApiError('login_failed', '微信登录失败');

  const r = await api.post('/api/login', { body: { code: res.code } });

  saveSession({
    token: r.token,
    scope: r.registered ? 'user' : 'register',
    user: r.registered ? r.user : null,
  });

  return { registered: !!r.registered, user: r.user || null };
}

/** 登记学号姓名。需要先 login() 拿到 register token。 */
export async function register(sid, name) {
  const r = await api.post('/api/register', {
    token: getToken(),
    body: { sid, name },
  });
  saveSession({ token: r.token, scope: 'user', user: r.user });
  return r.user;
}

/** 拉一次最新的用户信息（比如角色被改过） */
export async function refreshUser() {
  const r = await api.get('/api/me', { token: getToken() });
  saveSession({ scope: 'user', user: r.user });
  return r.user;
}

/**
 * 需要「已登记用户」的页面调它。
 * 没登记时抛一个 code === 'need_register' 的错误，页面跳去登记。
 */
export async function ensureSession() {
  if (getUser() && getToken()) return getUser();

  const r = await login();
  if (!r.registered) {
    const e = new Error('还没登记学号姓名');
    e.code = 'need_register';
    throw e;
  }
  return r.user;
}

/** 统一的错误处理：need_register 时跳登记页，其余弹提示 */
export function handleError(err, { toast = true } = {}) {
  if (err && err.code === 'need_register') {
    wx.navigateTo({ url: '/pages/profile/index?register=1' });
    return 'need_register';
  }
  if (toast) {
    platform().showToast({ title: (err && err.message) || '出错了' });
  }
  return (err && err.code) || 'unknown';
}
