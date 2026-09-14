/**
 * WXML / 页面 JS 的静态检查。
 *
 * 为什么需要它：本地没有微信开发者工具，跑不了真机。而下面这几类问题
 * **在真机上不报错、只是静默失效**：
 *   - bindtap 绑了一个不存在的方法   → 点了没反应
 *   - 用 navigateTo 跳 tabBar 页面    → 跳不过去，也不提示
 *   - wx:for 没有 wx:key              → 列表更新错乱
 *   - 模板里引用了 JS 里根本没有的字段 → 页面上是一片空白
 *
 * 这些都是纯静态能查出来的，没必要等到真机上才发现。
 */

/** 从页面 JS 里取出 Page({...}) 顶层成员名 */
export function extractPageMembers(js) {
  const names = new Set();
  // 必须容忍 async 前缀 —— 漏了它的话，所有 async 方法都会被误判成"不存在"，
  // 然后 lint 会报一堆假问题，比不报还糟。
  for (const m of js.matchAll(/^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*[:(]/gm)) {
    names.add(m[1]);
  }
  return names;
}

/** 从 WXML 里取出所有事件绑定的处理函数名 */
export function extractHandlers(wxml) {
  const out = [];
  for (const m of wxml.matchAll(/\b(?:bind|catch|capture-bind|capture-catch)[:]?([a-zA-Z]+)\s*=\s*"([^"{}]+)"/g)) {
    out.push({ event: m[1], name: m[2].trim() });
  }
  return out;
}

/** 取出 wx:for 声明的循环变量名（默认 item）和 index */
export function extractLoopAliases(wxml) {
  const aliases = new Set(['index']);
  for (const m of wxml.matchAll(/wx:for-item\s*=\s*"([^"]+)"/g)) aliases.add(m[1].trim());
  for (const m of wxml.matchAll(/wx:for-index\s*=\s*"([^"]+)"/g)) aliases.add(m[1].trim());
  // 没写 wx:for-item 时默认就是 item
  if (/wx:for\s*=/.test(wxml)) aliases.add('item');
  return aliases;
}

/** 取出模板里 {{ }} 用到的根标识符 */
export function extractTemplateRoots(wxml) {
  const roots = new Set();
  const skip = new Set(['true', 'false', 'null', 'undefined']);

  for (const m of wxml.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const expr = m[1];
    // 先去掉字符串字面量，避免把中文/空格当成标识符
    const cleaned = expr.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
    for (const id of cleaned.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)/g)) {
      const name = id[2];
      if (!skip.has(name)) roots.add(name);
    }
  }
  return roots;
}

/** 取出 WXML 里声明的 data-* 字段名 */
export function extractDataSetKeys(wxml) {
  const keys = new Set();
  for (const m of wxml.matchAll(/\bdata-([a-z0-9-]+)\s*=/gi)) {
    // data-stall-id → stallId（小程序会把连字符转成驼峰）
    const camel = m[1].replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    keys.add(camel);
  }
  return keys;
}

/** 取出 JS 里读取的 dataset 字段名 */
export function extractDatasetReads(js) {
  const keys = new Set();
  for (const m of js.matchAll(/\.dataset\.([A-Za-z_$][\w$]*)/g)) keys.add(m[1]);
  return keys;
}

/** 取出 JS 里的页面跳转调用 */
export function extractNavigations(js) {
  const out = [];
  // ★ 对象内容的匹配必须容忍模板字符串里的 ${...}。
  //   写成 [^}]* 的话，但凡 url 用了 `...${id}` 就整个匹配不上，
  //   而我的跳转几乎全是模板字符串 —— 那样这个检查等于没有。
  const re = /wx\.(navigateTo|redirectTo|switchTab|reLaunch|navigateBack)\s*\(\s*\{((?:\$\{[^}]*\}|[^}])*)\}/g;
  for (const m of js.matchAll(re)) {
    const api = m[1];
    const urlMatch = /url\s*:\s*[`'"]([^`'"]+)[`'"]/.exec(m[2]);
    if (urlMatch) out.push({ api, url: urlMatch[1] });
    else if (api === 'navigateBack') out.push({ api, url: null });
  }
  return out;
}

/** 把 `/pages/x/index?id=1` 规整成 `/pages/x/index` */
export function normalizeRoute(url) {
  if (!url) return null;
  return url.split('?')[0].replace(/\$\{[^}]*\}/g, 'X').replace(/\/X/g, '/X');
}

/**
 * 对一对 (wxml, js) 做检查，返回问题列表。
 * @param {object} ctx
 * @param {string} ctx.rel      相对路径，用于报错
 * @param {string} ctx.wxml
 * @param {string} ctx.js
 * @param {Set<string>} ctx.pages   app.json 里声明的主包页面（带前导 /）
 * @param {Set<string>} ctx.tabPages tabBar 页面（带前导 /）
 */
export function lintPage({ rel, wxml, js, pages = new Set(), tabPages = new Set() }) {
  const problems = [];
  const members = extractPageMembers(js);
  const aliases = extractLoopAliases(wxml);

  // ① 事件绑定的方法必须存在。不存在的话真机上就是「点了没反应」，不报错。
  for (const { event, name } of extractHandlers(wxml)) {
    if (!members.has(name)) {
      problems.push(`${rel}: bind${event}="${name}"，但页面 JS 里没有 ${name}() —— 点了不会有反应`);
    }
  }

  // ② wx:for 必须有 wx:key，否则列表更新会错乱
  const forCount = (wxml.match(/wx:for\s*=/g) || []).length;
  const keyCount = (wxml.match(/wx:key\s*=/g) || []).length;
  if (forCount > keyCount) {
    problems.push(`${rel}: 有 ${forCount} 个 wx:for 但只有 ${keyCount} 个 wx:key`);
  }

  // ③ 模板引用的字段，页面 JS 里至少要提到过
  for (const root of extractTemplateRoots(wxml)) {
    if (aliases.has(root)) continue;
    if (members.has(root)) continue;
    if (new RegExp(`\\b${root}\\b`).test(js)) continue;   // JS 里算出来的派生字段
    problems.push(`${rel}: 模板用了 {{${root}}}，但页面 JS 里找不到它`);
  }

  // ④ dataset 读的字段必须在 WXML 里声明过，否则是 undefined
  const declared = extractDataSetKeys(wxml);
  for (const key of extractDatasetReads(js)) {
    if (!declared.has(key)) {
      problems.push(`${rel}: JS 读了 dataset.${key}，但 WXML 里没有 data-${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`);
    }
  }

  // ⑤ 跳转方式要对：tabBar 页面只能用 switchTab / reLaunch
  for (const { api, url } of extractNavigations(js)) {
    const route = normalizeRoute(url);
    if (!route) continue;

    if (api === 'switchTab' && !tabPages.has(route)) {
      problems.push(`${rel}: switchTab 跳 ${route}，但它不是 tabBar 页面 —— 会失败`);
    }
    if ((api === 'navigateTo' || api === 'redirectTo') && tabPages.has(route)) {
      problems.push(`${rel}: ${api} 跳 tabBar 页面 ${route} —— 小程序会静默失败，必须用 switchTab`);
    }
    if (pages.size && !pages.has(route)) {
      problems.push(`${rel}: 跳转到 ${route}，但 app.json 里没声明这个页面`);
    }
  }

  return problems;
}
