/**
 * 小程序「开发者工具里能不能加载起来」的静态检查。
 *
 * 本地装不了微信开发者工具，所以导入之后会不会红屏，只能靠静态检查提前兜住。
 * 文件头先自测每条规则都抓得住对应的 bug，再拿去扫真实文件——
 * 「全绿」只有在证明过 linter 会红的前提下才有意义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkJson,
  checkWxmlTags,
  checkBindings,
  checkImageRefs,
  checkWxss,
  checkTabBar,
  checkConditionList,
  checkProjectConfig,
} from './helpers/mp-build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(p, 'utf8');

/** 递归收集某类文件，返回相对 miniprogram 的 posix 路径 */
function collect(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collect(full, ext, out);
    else if (e.name.endsWith(ext)) out.push(path.relative(MP, full).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * 造一个「相对某个文件解析资源路径」的判断函数。
 * WXSS 的 @import / url() 和 <image src> 都按当前文件所在目录解析；
 * 以 / 开头的是相对小程序根目录。
 */
function assetExistsFrom(fromRel) {
  return (ref) => {
    const clean = ref.replace(/[?#].*$/, '');
    const base = clean.startsWith('/') ? MP : path.dirname(path.join(MP, fromRel));
    return fs.existsSync(path.resolve(base, clean.replace(/^\//, '')));
  };
}

const appJson = () => JSON.parse(read(path.join(MP, 'app.json')));
const projectConfig = () => JSON.parse(read(path.join(MP, 'project.config.json')));

function declaredPages() {
  const cfg = appJson();
  return new Set([
    ...cfg.pages,
    ...cfg.subPackages.flatMap((sp) => sp.pages.map((p) => `${sp.root}/${p}`)),
  ].map((p) => '/' + p));
}

/** 把一批 (文件, 问题数组) 汇成一条好读的断言 */
function assertClean(problems) {
  assert.equal(problems.length, 0,
    `发现 ${problems.length} 个「一导入开发者工具就会红屏」的问题：\n` +
    problems.map((p) => '  · ' + p).join('\n'));
}

/* ============================================================
   一、先证明规则抓得住问题
   ============================================================ */

test('build 自测：能抓到 JSON 里的多余逗号', () => {
  const problems = checkJson('{\n  "a": 1,\n}\n', 'fake.json');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /JSON 解析失败/);
});

test('build 自测：能抓到带 BOM 的 JSON', () => {
  const problems = checkJson('\uFEFF{"a":1}', 'fake.json');
  assert.ok(problems.some((p) => /BOM/.test(p)), JSON.stringify(problems));
});

test('build 自测：正常的 JSON 不报问题', () => {
  assert.deepEqual(checkJson('{"a":[1,2]}', 'fake.json'), []);
});

test('build 自测：能抓到没闭合的 WXML 标签', () => {
  const problems = checkWxmlTags('<view>\n  <text>hi</text>\n', 'fake.wxml');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /<view> 没有闭合/);
});

test('build 自测：能抓到多余的结束标签', () => {
  const problems = checkWxmlTags('<view>hi</view></view>', 'fake.wxml');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /多了一个 <\/view>/);
});

test('build 自测：能抓到被提前截断的中间标签', () => {
  const problems = checkWxmlTags('<view><text>hi</view>', 'fake.wxml');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /<text> 没有闭合/);
});

test('build 自测：{{a < b}} 里的小于号不能当成标签', () => {
  const problems = checkWxmlTags('<view wx:if="{{a < b ? 1 : 2}}">hi</view>', 'fake.wxml');
  assert.deepEqual(problems, []);
});

test('build 自测：自闭合标签不该被要求闭合', () => {
  assert.deepEqual(checkWxmlTags('<input value="x" />\n<image src="/a.png" />', 'fake.wxml'), []);
});

test('build 自测：能抓到驼峰事件名（bindTap）', () => {
  const problems = checkBindings('<view bindTap="go">点我</view>', 'fake.wxml');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /bindTap/);
  assert.match(problems[0], /bindtap/);
});

test('build 自测：全小写和各种前缀都不该误报', () => {
  const wxml = [
    '<view bindtap="a" catchtap="b" bind:tap="c" catch:tap="d">x</view>',
    '<input bindinput="e" bindconfirm="f" bindblur="g" />',
    '<view capture-bind:tap="h" capture-catch:tap="i" bindlongpress="j">y</view>',
    '<scroll-view bindscrolltolower="k" bindscroll="l">z</scroll-view>',
  ].join('\n');
  assert.deepEqual(checkBindings(wxml, 'fake.wxml'), []);
});

test('build 自测：能抓到不存在的本地图片', () => {
  const problems = checkImageRefs(
    '<image src="/images/cat.png" mode="aspectFill" />',
    'fake.wxml',
    () => false
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cat\.png/);
});

test('build 自测：网络图片和动态 src 不查（前者不受白名单限制，后者运行时才知道）', () => {
  const wxml = '<image src="https://a.com/x.png" /><image src="{{item.cover}}" />';
  assert.deepEqual(checkImageRefs(wxml, 'fake.wxml', () => false), []);
});

test('build 自测：能抓到 WXSS 花括号不配对', () => {
  const problems = checkWxss('.a { color: red;', 'fake.wxss', () => true);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /花括号不配对/);
});

test('build 自测：注释里的花括号不能算进去', () => {
  assert.deepEqual(checkWxss('/* { */\n.a { color: red; }', 'fake.wxss', () => true), []);
});

test('build 自测：能抓到 @import 和 url() 指向不存在的文件', () => {
  const problems = checkWxss(
    '@import "./nope.wxss";\n.a { background: url(/img/nope.png); }',
    'fake.wxss',
    () => false
  );
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /nope\.wxss/.test(p)));
  assert.ok(problems.some((p) => /nope\.png/.test(p)));
});

test('build 自测：data: / http 形式的 url 不查', () => {
  const css = '.a { background: url(data:image/png;base64,AAA); }\n.b { background: url(https://a.com/x.png); }';
  assert.deepEqual(checkWxss(css, 'fake.wxss', () => false), []);
});

test('build 自测：能抓到 tabBar 数量越界、页面没声明、图标只给一半', () => {
  const cfg = {
    pages: ['pages/a/index'],
    tabBar: { list: [{ pagePath: 'pages/b/index', text: 'B', iconPath: '/i.png' }] },
  };
  const problems = checkTabBar(cfg, () => false);
  assert.ok(problems.some((p) => /2~5 项/.test(p)), JSON.stringify(problems));
  assert.ok(problems.some((p) => /不在 pages 中/.test(p)), JSON.stringify(problems));
  assert.ok(problems.some((p) => /成对出现/.test(p)), JSON.stringify(problems));
});

test('build 自测：能抓到编译模式指向已删除的页面', () => {
  const cfg = { condition: { miniprogram: { list: [{ name: '旧页面', pathName: 'pages/gone/index' }] } } };
  const problems = checkConditionList(cfg, new Set(['/pages/a/index']));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pages\/gone\/index/);
});

test('build 自测：能抓到 miniprogramRoot 指错（导入后是个空项目）', () => {
  const problems = checkProjectConfig(
    { appid: 'x', compileType: 'miniprogram', miniprogramRoot: './miniprogram/' },
    () => false
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /app\.json/);
});

/* ============================================================
   二、扫真实文件
   ============================================================ */

test('小程序：每个 json 都能解析（页面 json 出错时工具的提示很不直观）', () => {
  const files = collect(MP, '.json');
  assert.ok(files.length >= 12, `应该扫到 app.json + sitemap + project.config + 各页面 json，实际 ${files.length} 个`);

  const problems = [];
  for (const rel of files) problems.push(...checkJson(read(path.join(MP, rel)), rel));
  assertClean(problems);
});

test('小程序：所有 WXML 标签都配对', () => {
  const problems = [];
  for (const rel of collect(MP, '.wxml')) {
    problems.push(...checkWxmlTags(read(path.join(MP, rel)), rel));
  }
  assertClean(problems);
});

test('小程序：事件绑定名全是小写（驼峰不报错，只是永远不触发）', () => {
  const problems = [];
  for (const rel of collect(MP, '.wxml')) {
    problems.push(...checkBindings(read(path.join(MP, rel)), rel));
  }
  assertClean(problems);
});

test('小程序：WXML 里引用的本地图片都存在', () => {
  const problems = [];
  for (const rel of collect(MP, '.wxml')) {
    problems.push(...checkImageRefs(read(path.join(MP, rel)), rel, assetExistsFrom(rel)));
  }
  assertClean(problems);
});

test('小程序：WXSS 花括号配对，@import 与 url() 都能解析', () => {
  const problems = [];
  for (const rel of collect(MP, '.wxss')) {
    problems.push(...checkWxss(read(path.join(MP, rel)), rel, assetExistsFrom(rel)));
  }
  assertClean(problems);
});

test('小程序：tabBar 声明合法（数量、页面、图标）', () => {
  assertClean(checkTabBar(appJson(), assetExistsFrom('app.json')));
});

test('小程序：project.config.json 的编译模式都还指向真实页面', () => {
  assertClean(checkConditionList(projectConfig(), declaredPages()));
});

test('小程序：project.config.json 指向的就是 miniprogram 这一层', () => {
  const cfg = projectConfig();
  const ok = (root) => fs.existsSync(path.resolve(MP, root, 'app.json'));
  assertClean(checkProjectConfig(cfg, ok));
});

test('小程序：零二进制资源是刻意的（图标用 emoji），别不小心提交了图片', () => {
  const assets = fs.readdirSync(MP, { recursive: true })
    .filter((f) => /\.(png|jpe?g|gif|svg|webp|ttf|woff2?)$/i.test(String(f)));
  assert.deepEqual(assets, [],
    '项目刻意不带任何图片/字体资源（图标一律用 emoji），' +
    '这些文件要么是误提交，要么得同时补上 tabBar 图标与版权说明：\n' + assets.join('\n'));
});
