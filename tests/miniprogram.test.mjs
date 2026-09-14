/**
 * 小程序骨架校验。
 *
 * 本地没有微信开发者工具，跑不了真机预览，所以验收方式是把
 * **微信的硬性规则**和**前后端契约**都变成断言。
 *
 * 这里挡住的都是「不写测试就一定会踩、而且报错信息完全指不到真正原因」的坑：
 *   - tabBar 页面必须在主包，不能指向分包
 *   - 主包不能 require 分包的文件（反过来可以）
 *   - 小程序调用的接口，后端必须真的存在
 *   - 混用 require 和 import
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES } from '../server/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

/** 递归收集文件 */
function walk(dir, filter = () => true) {
  if (!exists(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

const appJson = () => JSON.parse(read(path.join(MP, 'app.json')));

const jsFiles = () => walk(MP, (f) => f.endsWith('.js'));
const allSourceFiles = () => walk(MP, (f) => /\.(js|wxml|wxss|json)$/.test(f));

/* ============================================================
   ★ 微信的硬性规则
   ============================================================ */

test('小程序：app.json 合法，且声明的每个页面都齐全', () => {
  const cfg = appJson();
  const declared = [
    ...cfg.pages.map((p) => ({ full: p, pkg: 'main' })),
    ...cfg.subPackages.flatMap((sp) =>
      sp.pages.map((p) => ({ full: `${sp.root}/${p}`, pkg: sp.root }))
    ),
  ];

  assert.ok(declared.length >= 8, '页面太少了，检查一下是不是漏声明了');

  const problems = [];
  for (const { full } of declared) {
    // 页面至少要有 .js 和 .wxml，缺一个开发者工具就会报错
    for (const ext of ['.js', '.wxml']) {
      if (!exists(path.join(MP, full + ext))) problems.push(`缺少 ${full}${ext}`);
    }
  }
  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

test('小程序：tabBar 页面必须在主包内（不能指向分包）', () => {
  const cfg = appJson();
  const subRoots = cfg.subPackages.map((s) => s.root);

  for (const item of cfg.tabBar.list) {
    assert.ok(cfg.pages.includes(item.pagePath),
      `tabBar 的 ${item.pagePath} 不在主包 pages 里 —— 微信不允许 tabBar 指向分包页面`);

    for (const root of subRoots) {
      assert.ok(!item.pagePath.startsWith(root + '/'),
        `${item.pagePath} 落在分包 ${root} 里，tabBar 不能这么写`);
    }
  }
});

test('小程序：主包不能引用分包的文件（反过来可以）', () => {
  const cfg = appJson();
  const subRoots = cfg.subPackages.map((s) => s.root);
  const problems = [];

  for (const file of jsFiles()) {
    const rel = path.relative(MP, file).replace(/\\/g, '/');
    const inSub = subRoots.find((r) => rel.startsWith(r + '/'));
    if (inSub) continue;                        // 分包引用谁都可以

    for (const [, spec] of read(file).matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (!spec.startsWith('.')) continue;      // 只看相对路径
      const resolved = path.resolve(path.dirname(file), spec);
      const resolvedRel = path.relative(MP, resolved).replace(/\\/g, '/');
      if (subRoots.some((r) => resolvedRel.startsWith(r + '/'))) {
        problems.push(`${rel} 引用了分包文件 ${spec}`);
      }
    }
  }

  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

test('小程序：所有相对 import 都能解析到真实文件', () => {
  const problems = [];

  for (const file of jsFiles()) {
    for (const [, spec] of read(file).matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      if (!exists(resolved) && !exists(resolved + '.js')) {
        problems.push(`${path.relative(MP, file)} → ${spec} 不存在`);
      }
    }
  }

  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

test('小程序：不许混用 require 和 import（我在这里栽过一次）', () => {
  const problems = [];

  for (const file of jsFiles()) {
    const src = read(file);
    if (/^\s*import\s/m.test(src) && /\brequire\s*\(/.test(src)) {
      problems.push(path.relative(MP, file));
    }
  }

  assert.deepEqual(problems, [],
    '这些文件同时用了 import 和 require，小程序里会报错：\n' + problems.join('\n'));
});

/* ============================================================
   ★ 前后端契约：小程序调用的接口，后端必须真的有
   ============================================================ */

test('小程序：调用的每个接口都在后端路由表里', () => {
  const known = new Set(Object.values(ROUTES).length ? Object.keys(ROUTES).map((k) => k.split(' ')[1]) : []);
  assert.ok(known.size >= 8, '路由表读取异常');

  const used = new Map();   // path -> 出现的位置
  for (const file of jsFiles()) {
    for (const [, apiPath] of read(file).matchAll(/['"](\/api\/[a-z0-9-]+)['"]/g)) {
      if (!used.has(apiPath)) used.set(apiPath, []);
      used.get(apiPath).push(path.relative(MP, file));
    }
  }

  assert.ok(used.size > 0, '没扫到任何接口调用，正则可能失效了');

  const unknown = [];
  for (const [apiPath, where] of used) {
    if (!known.has(apiPath)) unknown.push(`${apiPath}（出现在 ${[...new Set(where)].join(', ')}）`);
  }

  assert.deepEqual(unknown, [],
    '小程序调用了后端没有的接口：\n' + unknown.join('\n') +
    '\n后端现有：' + [...known].sort().join(', '));
});

test('小程序：每个接口调用的 HTTP 方法也要对得上', () => {
  const methods = new Map();   // path -> Set(方法)
  for (const key of Object.keys(ROUTES)) {
    const [m, p] = key.split(' ');
    if (!methods.has(p)) methods.set(p, new Set());
    methods.get(p).add(m);
  }

  const problems = [];
  for (const file of jsFiles()) {
    const src = read(file);
    for (const [, fn, apiPath] of src.matchAll(/\bapi\.(get|post)\s*\(\s*['"](\/api\/[a-z0-9-]+)['"]/g)) {
      const method = fn === 'get' ? 'GET' : 'POST';
      const allowed = methods.get(apiPath);
      if (allowed && !allowed.has(method)) {
        problems.push(`${path.relative(MP, file)} 用 ${method} 调 ${apiPath}，后端只接受 ${[...allowed].join('/')}`);
      }
    }
  }

  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

/* ============================================================
   合规红线
   ============================================================ */

test('小程序：界面里不出现任何交易或金额用语', () => {
  const FORBIDDEN = ['价格', '金额', '下单', '订单', '购买', '购物车', '结算',
                     '库存', '发货', '收货', '支付', '售价'];
  const problems = [];

  for (const file of allSourceFiles()) {
    const rel = path.relative(MP, file).replace(/\\/g, '/');
    if (rel === 'project.config.json' || rel === 'app.json') continue;  // 配置里的 desc 不算界面
    const src = read(file);
    for (const w of FORBIDDEN) {
      if (src.includes(w)) problems.push(`${rel} 出现禁用词「${w}」`);
    }
    const m = src.match(/¥|\d+\s*元/);
    if (m) problems.push(`${rel} 出现金额：${JSON.stringify(m[0])}`);
  }

  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

test('小程序：关键页面都带「仅登记名额、不收费」的声明', () => {
  for (const f of ['pages/home/index.wxml', 'pages/profile/index.wxml',
                   'packageBazaar/pages/items/index.wxml',
                   'packageBazaar/pages/detail/index.wxml']) {
    const src = read(path.join(MP, f));
    assert.match(src, /(只|仅)(登记|锁定)[^。]{0,8}名额/, `${f} 缺少合规声明`);
  }
});

/* ============================================================
   结构合理性
   ============================================================ */

test('小程序：图鉴数据放主包（tabBar 页面要用，主包拿不到分包的文件）', () => {
  assert.ok(exists(path.join(MP, 'data', 'cats.js')), 'data/cats.js 必须在主包');

  const catsPage = read(path.join(MP, 'pages', 'cats', 'index.js'));
  assert.match(catsPage, /from '\.\.\/\.\.\/data\/cats\.js'/,
    '主包的图鉴列表页应当直接从主包拿数据');
});

test('小程序：分包目录与 app.json 声明一致', () => {
  const cfg = appJson();
  for (const sp of cfg.subPackages) {
    assert.ok(exists(path.join(MP, sp.root)), `分包目录 ${sp.root} 不存在`);
    assert.match(sp.root, /^package[A-Z]/,
      `分包目录 ${sp.root} 命名不规范，建议 packageXxx`);
  }
});

test('小程序：主包体积还很小（上限 2MB，留足余量）', () => {
  const cfg = appJson();
  const subRoots = cfg.subPackages.map((s) => s.root);

  let mainBytes = 0;
  for (const f of walk(MP)) {
    const rel = path.relative(MP, f).replace(/\\/g, '/');
    if (subRoots.some((r) => rel.startsWith(r + '/'))) continue;
    mainBytes += fs.statSync(f).size;
  }

  const kb = mainBytes / 1024;
  assert.ok(kb < 512, `主包已经有 ${kb.toFixed(0)} KB，骨架阶段不该这么大`);
});

test('小程序：代码里不含任何硬编码的密钥', () => {
  const problems = [];
  for (const file of jsFiles()) {
    const src = read(file);
    // AppSecret 只能待在后端。出现在小程序里就等于公开了。
    if (/WX_SECRET\s*[:=]\s*['"][^'"]{8,}/.test(src)) problems.push(path.relative(MP, file));
    if (/SESSION_SECRET\s*[:=]\s*['"][^'"]{8,}/.test(src)) problems.push(path.relative(MP, file));
  }
  assert.deepEqual(problems, [], '小程序里不能出现任何密钥：\n' + problems.join('\n'));
});

test('小程序：所有 JS 文件语法正确（本地跑不了真机，至少保证能编译）', async () => {
  // 取巧的办法：动态 import 每个文件。
  //   抛 SyntaxError   → 真的有语法错
  //   抛 ReferenceError → 语法没问题，只是 Page/App/wx 这些全局在 Node 里不存在
  // 两者必须分开看，否则「跑不起来」什么都说明不了。
  const problems = [];

  for (const file of jsFiles()) {
    try {
      await import(new URL('file://' + file.replace(/\\/g, '/')).href);
    } catch (e) {
      const isSyntax = (e && e.constructor && e.constructor.name === 'SyntaxError')
        || /SyntaxError/.test(String(e));
      if (isSyntax) {
        problems.push(`${path.relative(MP, file)}: ${e.message}`);
      }
      // 其余一律当作「缺小程序全局」，不算失败
    }
  }

  assert.deepEqual(problems, [], '存在语法错误：\n' + problems.join('\n'));
});

test('小程序：生产环境地址必须是 HTTPS 且不是占位符以外的假地址', () => {
  const cfg = read(path.join(MP, 'config.js'));
  const m = /PROD_BASE\s*=\s*'([^']+)'/.exec(cfg);
  assert.ok(m, '找不到 PROD_BASE');

  const url = m[1];
  assert.match(url, /^https:\/\//,
    'Prod 必须是 HTTPS —— 小程序的 request 合法域名不接受 http');
  assert.doesNotMatch(url, /127\.0\.0\.1|localhost/,
    '生产地址不能是本机地址，正式版发不出请求');
  assert.doesNotMatch(url, /^https:\/\/\d+\.\d+\.\d+\.\d+/,
    '不能直接用 IP —— 小程序不支持 IP，必须用已备案的域名');
});
