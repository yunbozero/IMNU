/**
 * 小程序「能不能在开发者工具里加载起来」这类问题的静态检查。
 *
 * 与 wxml-lint.mjs 的分工：
 *   wxml-lint.mjs  管**语义**——绑了不存在的方法、跳了没声明的页面、模板引用了没定义的字段。
 *                  这类问题的表现是「点上去没反应」，页面还能打开。
 *   本文件          管**编译与加载**——JSON 能不能解析、标签闭没闭、事件名大小写对不对、
 *                  引用的资源在不在、编译模式的 pathName 还存不存在。
 *                  这类问题的表现是**直接红屏 / 白屏**，连页面都进不去。
 *
 * 之所以要单独查一遍：本地跑不了微信开发者工具，而这些错误只有真机或工具里才会暴露。
 * 全部做成纯函数，方便先在自测里证明「它确实抓得住」，再去扫真实文件——
 * 否则「全绿」什么都说明不了（这条纪律是被 secrets.test.mjs 的一次假绿教训出来的）。
 */

/* ============================================================
   JSON
   ============================================================ */

/**
 * 检查一个 JSON 文件能不能解析。
 * 多一个逗号、少一个引号，开发者工具会直接报「app.json 解析失败」之类，
 * 而且**页面 json 出错的提示很不直观**，所以这里逐个文件查。
 */
export function checkJson(text, rel) {
  const problems = [];

  if (text.charCodeAt(0) === 0xfeff) {
    problems.push(`${rel}: 开头有 BOM（开发者工具对带 BOM 的 json 兼容性不好，去掉）`);
  }

  try {
    JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    problems.push(`${rel}: JSON 解析失败 —— ${e.message}`);
  }

  return problems;
}

/* ============================================================
   WXML
   ============================================================ */

/**
 * WXML 里不需要闭合标签的元素。
 * 故意保守：只收「永远不可能有子节点」的。
 * 例如 textarea / canvas 不收，因为写成 <textarea></textarea> 也合法，
 * 收进来会把合法写法误判成「多余的闭合标签」。
 */
const VOID_TAGS = new Set([
  'input', 'image', 'import', 'include', 'icon', 'progress', 'slider', 'switch',
  'open-data', 'official-account', 'ad', 'live-player', 'live-pusher',
  'voip-room', 'web-view',
]);

/** 把 {{...}} 抹掉，避免里面的 < > 被当成标签（例如 {{a < b ? 1 : 2}}） */
const stripMustache = (s) => s.replace(/\{\{[\s\S]*?\}\}/g, 'EXPR');

const TAG_RE = /<(\/?)([A-Za-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/**
 * 标签是否配对。
 * 漏一个 </view> 开发者工具会报编译错误，而且报的行号往往不是真正出问题的那行。
 */
export function checkWxmlTags(wxml, rel) {
  const problems = [];
  const src = stripMustache(wxml.replace(/<!--[\s\S]*?-->/g, ''));
  const stack = [];

  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(src)) !== null) {
    const [, closing, name, , selfClose] = m;

    if (closing) {
      if (VOID_TAGS.has(name)) {
        problems.push(`${rel}: <${name}> 是自闭合标签，不该写成 </${name}>`);
        continue;
      }
      const idx = stack.lastIndexOf(name);
      if (idx === -1) {
        problems.push(`${rel}: 多了一个 </${name}>，找不到对应的开始标签`);
      } else {
        // 中间的标签是被这个 </name> 提前截断的
        for (let i = stack.length - 1; i > idx; i--) {
          problems.push(`${rel}: <${stack[i]}> 没有闭合，就被 </${name}> 截断了`);
        }
        stack.length = idx;
      }
    } else if (!selfClose && !VOID_TAGS.has(name)) {
      stack.push(name);
    }
  }

  for (const t of stack) {
    problems.push(`${rel}: <${t}> 没有闭合`);
  }

  return problems;
}

/**
 * 事件名必须是全小写。
 *
 * 微信的事件绑定是 `bindtap` 而不是 `bindTap`，`bindinput` 而不是 `bindInput`。
 * 写成驼峰**不会报错**，只是永远不触发——属于最难查的一类问题，所以单独立一条规则。
 */
export function checkBindings(wxml, rel) {
  const problems = [];
  const src = stripMustache(wxml.replace(/<!--[\s\S]*?-->/g, ''));
  const RE = /\s(?:capture-)?(?:bind|catch):?([A-Za-z][\w-]*)\s*=/g;

  let m;
  while ((m = RE.exec(src)) !== null) {
    if (/[A-Z]/.test(m[1])) {
      const attr = m[0].trim().replace(/=$/, '');
      problems.push(
        `${rel}: 事件名 "${attr}" 含大写字母，微信只认全小写，` +
        `应该写成 "${attr.toLowerCase()}" —— 写错了不报错，只是点了没反应`
      );
    }
  }

  return problems;
}

/**
 * <image src="..."> 引用的本地图片必须存在。
 *
 * 本项目图标一律用 emoji 文本（零二进制资源），所以任何本地图片引用都值得停下来看一眼：
 * 要么是写错了路径，要么是漏把图片提交进去（.gitignore 拦掉了）。
 * 网络图片和 {{}} 动态值不管——前者不受域名白名单限制，后者运行时才知道。
 */
export function checkImageRefs(wxml, rel, assetExists) {
  const problems = [];
  const RE = /<image\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)')/g;

  let m;
  while ((m = RE.exec(wxml)) !== null) {
    const src = (m[2] ?? m[3] ?? '').trim();
    if (!src) continue;
    if (src.includes('{{')) continue;
    if (/^(https?:|data:|wxfile:|\/\/)/i.test(src)) continue;
    if (!assetExists(src)) {
      problems.push(`${rel}: <image src="${src}"> 指向的图片不存在`);
    }
  }

  return problems;
}

/* ============================================================
   WXSS
   ============================================================ */

/**
 * 样式文件的三个坑：花括号不配对、@import 路径写错、url() 引用了不存在的资源。
 * 花括号不配对整个页面的样式都会错乱（而且不报错）。
 */
export function checkWxss(wxss, rel, assetExists) {
  const problems = [];
  // 先去掉注释，否则注释里的花括号会被算进去
  const bare = wxss.replace(/\/\*[\s\S]*?\*\//g, '');

  const open = (bare.match(/\{/g) || []).length;
  const close = (bare.match(/\}/g) || []).length;
  if (open !== close) {
    problems.push(`${rel}: 花括号不配对（${open} 个 {，${close} 个 }）`);
  }

  for (const m of bare.matchAll(/@import\s+["']([^"']+)["']/g)) {
    const ref = m[1];
    if (/^(https?:|\/\/)/i.test(ref)) continue;
    if (!assetExists(ref)) {
      problems.push(`${rel}: @import "${ref}" 指向的文件不存在`);
    }
  }

  for (const m of bare.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    const ref = m[1].trim();
    if (/^(data:|https?:|\/\/|#)/i.test(ref)) continue;
    if (!assetExists(ref)) {
      problems.push(`${rel}: url(${ref}) 引用的资源不存在`);
    }
  }

  return problems;
}

/* ============================================================
   app.json / project.config.json
   ============================================================ */

/**
 * tabBar 的形状要求。
 * 微信硬性规定 2~5 个；pagePath 必须在 pages 里（指向分包是另一个测试管的，
 * 这里只保证「声明得对得上」）；图标要么给一对、要么都不给。
 */
export function checkTabBar(cfg, exists) {
  const problems = [];
  const list = cfg.tabBar?.list;
  if (!list) return problems;

  if (list.length < 2 || list.length > 5) {
    problems.push(`app.json: tabBar 必须是 2~5 项，现在是 ${list.length} 项`);
  }

  const pages = new Set(cfg.pages || []);
  const seen = new Set();

  for (const item of list) {
    if (!pages.has(item.pagePath)) {
      problems.push(`app.json: tabBar 里的 "${item.pagePath}" 不在 pages 中`);
    }
    if (seen.has(item.pagePath)) {
      problems.push(`app.json: tabBar 里 "${item.pagePath}" 重复了`);
    }
    seen.add(item.pagePath);

    const has = Boolean(item.iconPath);
    const hasSel = Boolean(item.selectedIconPath);
    if (has !== hasSel) {
      problems.push(`app.json: "${item.pagePath}" 的 iconPath / selectedIconPath 必须成对出现`);
    }
    for (const key of ['iconPath', 'selectedIconPath']) {
      if (item[key] && !exists(item[key])) {
        problems.push(`app.json: tabBar 的 ${key} "${item[key]}" 文件不存在`);
      }
    }
  }

  return problems;
}

/**
 * project.config.json 里存的「编译模式」。
 * pathName 指向一个已经删掉/改名的页面时，开发者工具会报错或者编译到空白页，
 * 而这种残留特别容易在重构后留下来。
 */
export function checkConditionList(cfg, declaredPages) {
  const problems = [];
  const list = cfg.condition?.miniprogram?.list || [];

  for (const item of list) {
    const p = String(item.pathName || '').replace(/^\//, '');
    if (!declaredPages.has('/' + p)) {
      problems.push(`project.config.json: 编译模式「${item.name || p}」指向的 ${p} 没有在 app.json 里声明`);
    }
  }

  return problems;
}

/**
 * project.config.json 本身。
 * miniprogramRoot 指错的话，开发者工具打开是一个空项目——这是导入时最常见的翻车点。
 */
export function checkProjectConfig(cfg, appJsonExistsAt) {
  const problems = [];

  if (!cfg.appid) {
    problems.push('project.config.json: 缺 appid（真机预览和上传都需要）');
  }
  if (cfg.compileType !== 'miniprogram') {
    problems.push(`project.config.json: compileType 应该是 "miniprogram"，现在是 "${cfg.compileType}"`);
  }

  const root = cfg.miniprogramRoot ?? '';
  if (!appJsonExistsAt(root)) {
    problems.push(
      `project.config.json: miniprogramRoot "${root}" 下面没有 app.json —— ` +
      '开发者工具会打开一个空项目，导入时请选 miniprogram 这一层目录'
    );
  }

  return problems;
}
