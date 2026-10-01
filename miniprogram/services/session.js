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

/**
 * 界面用的角色判定。
 *
 * ⚠️ 这两个列表是服务端 `server/roles.mjs` 的**副本**（小程序不能 import 服务端代码），
 *    所以它们必须和那边的 `canRedeem` / `canManage` 完全一致。
 *    这里曾经手写成 ['volunteer','admin','owner']，**漏了 deputy** ——
 *    于是副主任管理员在界面上被当成学生，管理入口压根不显示。
 *    `tests/miniprogram.test.mjs` 会拿服务端的角色表来校验这两个列表，改了会红。
 *
 * 注意这只是**界面控制**，真正的权限判定始终在服务端。
 */
export const ROLES_CAN_REDEEM = ['volunteer', 'deputy', 'admin', 'owner'];
export const ROLES_CAN_MANAGE = ['deputy', 'admin', 'owner'];

/** 能进核销台（志愿者及以上） */
export function isStaff() {
  const u = loadUser();
  return !!u && ROLES_CAN_REDEEM.includes(u.role);
}

/** 能进管理端（副主任管理员及以上）。门槛比核销台高一级。 */
export function isManager() {
  const u = loadUser();
  return !!u && ROLES_CAN_MANAGE.includes(u.role);
}

/**
 * 角色显示名。同样是服务端 ROLE_LABEL 的副本。
 *
 * 之前界面只有「志愿者 / 学生」两档，于是**管理员也被显示成志愿者**。
 * 测试会校验这里的键覆盖服务端的全部角色，漏一个就红。
 */
export const ROLE_LABEL = {
  student: '学生',
  volunteer: '志愿者',
  deputy: '副主任管理员',
  admin: '管理员',
  owner: '超级管理员',
};

export const roleLabel = (user) => (user && ROLE_LABEL[user.role]) || '学生';

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
