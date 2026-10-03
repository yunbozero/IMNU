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
/**
 * 能碰「影响全场」的东西：撤销误核销、改每账号上限、**建/结束活动**。
 *
 * 以前这一段是**手写**在 reservations 页面里的（`role === 'admin' || role === 'owner'`），
 * 改服务端规则时那边不会跟着动，也没有测试盯着 —— 现在收在这里，由测试比对。
 */
export const ROLES_CAN_ADMINISTER = ['admin', 'owner'];

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

/** 能撤销核销 / 改设置 / 建活动（一级管理员及以上）。比管理端再高一级。 */
export function isSeniorManager() {
  const u = loadUser();
  return !!u && ROLES_CAN_ADMINISTER.includes(u.role);
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
 * 微信登录最多等这么久。
 *
 * ★ 为什么必须有超时：`wx.login` 的 **fail 回调在个别情况下根本不会触发**
 *   （微信会话状态坏了、真机调试的通道卡住）。Promise 于是永远不 settle，
 *   上层一直 await 下去 —— 界面停在「提交中…」，按钮一直是禁用的，
 *   **既没有报错，也没有重试入口**。用户能说的只有「点了没反应」，
 *   而这类静默挂起比报错难查得多。
 *
 *   `api.post` 自己带 10 秒超时（见 services/api.js 的 REQUEST_TIMEOUT），
 *   但 `wx.login` 是微信的原生 API，没有超时参数，只能在这儿自己兜。
 */
export const LOGIN_TIMEOUT_MS = 15000;

/** 给 promise 加超时。到点就 reject，不再等它自己回来。 */
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * 走一遍 wx.login → /api/login。
 * 该登记还是已登记都能调，返回 { registered, user }。
 *
 * `timeoutMs` 只为测试而暴露 —— 生产用默认值。不然测这条得真等 15 秒。
 */
export async function login({ timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const res = await withTimeout(
    platform().login(),
    timeoutMs,
    // 这句话要能照着做：「退出小程序重进」是用户唯一有效的自救动作
    () => new api.ApiError('login_timeout', '微信登录没有响应，请退出小程序重进'),
  );
  if (!res || !res.code) throw new api.ApiError('login_failed', '微信登录失败');

  const r = await api.post('/api/login', { body: { code: res.code } });

  saveSession({
    token: r.token,
    scope: r.registered ? 'user' : 'register',
    user: r.registered ? r.user : null,
  });

  return { registered: !!r.registered, user: r.user || null };
}

/**
 * 登记昵称。需要先 login() 拿到 register token。
 *
 * 不再收学号：小程序里没法验证身份，收一个验证不了的学号只会让人以为验过了。
 * 服务端的 sid 字段仍在（可选），传了还是会按格式校验并存下来。
 */
export async function register(name) {
  const r = await api.post('/api/register', {
    token: getToken(),
    body: { name },
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
