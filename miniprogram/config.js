/**
 * 全局配置。
 *
 * 换环境只改这一个文件。
 *
 * ⚠️ 正式版请求的域名必须是**已备案的 HTTPS 域名**，而且要加进
 *    微信公众平台 → 开发管理 → 开发设置 → 服务器域名 → request 合法域名。
 *    用 IP、localhost 或没备案的域名，正式版一律发不出请求。
 *
 *    开发阶段可以在开发者工具里勾「不校验合法域名」临时绕过，
 *    但那只在开发工具里有效，真机预览和线上都不行。
 */

// 本地联调时用这个（先把后端起在本机，再在开发者工具里勾掉域名校验）
const DEV_BASE = 'http://127.0.0.1:3000';
const PROD_BASE = 'https://neishidemao.cn';

/**
 * 选哪个地址，只看**跑在哪儿**，不能只看 envVersion。
 *
 * 这里曾经踩过坑：`__wxConfig.envVersion` 只有在正式版才是 'release'，
 * 开发者工具是 'develop'，体验版和真机预览是 'trial'。当时写成
 * `IS_DEV ? DEV_BASE : PROD_BASE`，于是**真机预览也会拿到 127.0.0.1** ——
 * 而那是手机自己，所有请求必然失败，看起来就像后端挂了。
 *
 * 所以必须用 platform 把「开发者工具」和「真机」分开：
 * 只有模拟器里的 platform 才是 'devtools'，真机是 ios / android / …
 * 真机连不到本机后端，只能走线上地址。
 *
 * 读不到环境时（比如在 Node 里被 import）保守选线上，不要意外连本机。
 */
export function pickBaseUrl(env = {}) {
  return env.platform === 'devtools' ? DEV_BASE : PROD_BASE;
}

/** 读运行环境；读不到就返回空对象，交给 pickBaseUrl 兜底 */
function readEnv() {
  try {
    if (typeof wx === 'undefined') return {};
    // getDeviceInfo 是新接口，旧基础库没有，退回到 getSystemInfoSync
    const info = typeof wx.getDeviceInfo === 'function'
      ? wx.getDeviceInfo()
      : wx.getSystemInfoSync();

    let envVersion;
    try {
      envVersion = __wxConfig.envVersion;
    } catch {
      envVersion = undefined;
    }

    return { platform: info && info.platform, envVersion };
  } catch {
    return {};
  }
}

const ENV = readEnv();

export const API_BASE = PROD_BASE;

/** 是否跑在开发者工具里 —— 只有这里才连本机后端 */
export const IS_DEVTOOLS = ENV.platform === 'devtools';

/**
 * 是否开发环境（开发版 / 体验版 / 真机预览都算）。
 * ⚠️ 只能用来做界面提示之类的判断，**不要**拿它去选请求地址 ——
 *    真机也会是 true，见上面 pickBaseUrl 的注释。
 */
export const IS_DEV = (() => {
  try {
    return __wxConfig.envVersion !== 'release';
  } catch {
    return false;
  }
})();

/** 当前生效的地址 */
export const BASE_URL = pickBaseUrl(ENV);

export const REQUEST_TIMEOUT = 10000;

/** 义卖活动的时间地点兜底文案（接口拿不到时用） */
export const FALLBACK_EVENT_TEXT = {
  date: '待定',
  place: '待定',
};
