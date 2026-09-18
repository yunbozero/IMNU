/**
 * 全局配置。
 *
 * 换环境只改这一个文件。
 *
 * ⚠️ baseUrl 必须是**已备案的 HTTPS 域名**，而且要加进
 *    微信公众平台 → 开发管理 → 开发设置 → 服务器域名 → request 合法域名。
 *    用 IP、localhost 或没备案的域名，正式版一律发不出请求。
 *
 *    开发阶段可以在开发者工具里勾「不校验合法域名」临时绕过，
 *    但那只在开发工具里有效，真机预览和线上都不行。
 */

// 本地联调时改成 http://127.0.0.1:3000（并在开发者工具里勾掉域名校验）
const DEV_BASE = 'http://127.0.0.1:3000';
const PROD_BASE = 'https://neishidemao.cn';

export const API_BASE = PROD_BASE;

/** 是否开发环境。开发者工具里 __wxConfig.envVersion 是 'develop' */
export const IS_DEV = (() => {
  try {
    return __wxConfig.envVersion !== 'release';
  } catch {
    return false;
  }
})();

/** 当前生效的地址（开发环境自动回落，省得每次手改） */
export const BASE_URL = IS_DEV ? DEV_BASE : API_BASE;

export const REQUEST_TIMEOUT = 10000;

/** 义卖活动的时间地点兜底文案（接口拿不到时用） */
export const FALLBACK_EVENT_TEXT = {
  date: '待定',
  place: '待定',
};
