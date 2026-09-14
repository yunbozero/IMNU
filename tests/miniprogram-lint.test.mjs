/**
 * 小程序页面的静态检查。
 *
 * 先自测 lint 本身能不能抓到问题（否则「全绿」什么都说明不了），
 * 再拿它扫真实页面。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintPage } from './helpers/wxml-lint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(p, 'utf8');

const appJson = () => JSON.parse(read(path.join(MP, 'app.json')));

/** app.json 里声明的全部页面，带前导 / */
function declaredPages() {
  const cfg = appJson();
  return new Set([
    ...cfg.pages,
    ...cfg.subPackages.flatMap((sp) => sp.pages.map((p) => `${sp.root}/${p}`)),
  ].map((p) => '/' + p));
}

function tabPages() {
  return new Set(appJson().tabBar.list.map((i) => '/' + i.pagePath));
}

/** 找出每个页面目录（有 index.wxml 的） */
function pageDirs() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
    }
    if (fs.existsSync(path.join(dir, 'index.wxml'))) out.push(dir);
  };
  walk(MP);
  return out;
}

/* ============================================================
   先证明 lint 抓得住问题
   ============================================================ */

test('lint 自测：能抓到「绑了不存在的方法」', () => {
  const problems = lintPage({
    rel: 'fake',
    wxml: '<view bindtap="onMissingThing">点我</view>',
    js: 'Page({\n  onLoad() {},\n});\n',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /onMissingThing/);
  assert.match(problems[0], /点了不会有反应/);
});

test('lint 自测：能抓到「navigateTo 跳 tabBar 页面」', () => {
  const problems = lintPage({
    rel: 'fake',
    wxml: '<view>hi</view>',
    js: "Page({\n  go() { wx.navigateTo({ url: '/pages/cats/index' }); },\n});\n",
    pages: new Set(['/pages/cats/index']),
    tabPages: new Set(['/pages/cats/index']),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /静默失败|switchTab/);
});

test('lint 自测：能抓到「switchTab 跳非 tabBar 页面」', () => {
  const problems = lintPage({
    rel: 'fake',
    wxml: '<view>hi</view>',
    js: "Page({\n  go() { wx.switchTab({ url: '/packageBazaar/pages/items/index' }); },\n});\n",
    pages: new Set(['/packageBazaar/pages/items/index']),
    tabPages: new Set(['/pages/home/index']),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /不是 tabBar 页面/);
});

test('lint 自测：能抓到「wx:for 缺 wx:key」', () => {
  const problems = lintPage({
    rel: 'fake',
    wxml: '<view wx:for="{{list}}">{{item}}</view>',
    js: 'Page({\n  data: { list: [] },\n});\n',
  });
  assert.ok(problems.some((p) => /wx:key/.test(p)), JSON.stringify(problems));
});

test('lint 自测：能抓到「模板引用了 JS 里没有的字段」', () => {
  const problems = lintPage({
    rel: 'fake',
    wxml: '<view>{{neverDefined}}</view>',
    js: 'Page({\n  data: { other: 1 },\n});\n',
  });
  assert.ok(problems.some((p) => /neverDefined/.test(p)), JSON.stringify(problems));
});

test('lint 自测：能抓到「跳去没声明的页面」', () => {
  const problems = lintPage({
    rel: 'fake',
    wxml: '<view>hi</view>',
    js: "Page({\n  go() { wx.navigateTo({ url: '/pages/ghost/index' }); },\n});\n",
    pages: new Set(['/pages/home/index']),
    tabPages: new Set(['/pages/home/index']),
  });
  assert.ok(problems.some((p) => /没声明/.test(p)), JSON.stringify(problems));
});

test('lint 自测：url 是模板字符串时也要能查（这里的正则曾经漏了 ${}）', () => {
  const problems = lintPage({
    rel: 'fake',
    wxml: '<view>hi</view>',
    js: 'Page({\n  go(e) { wx.navigateTo({ url: `/pages/cats/index?id=${e.currentTarget.dataset.id}` }); },\n});\n',
    pages: new Set(['/pages/cats/index']),
    tabPages: new Set(['/pages/cats/index']),
  });
  // 这个用例会同时命中两条规则（跳转方式 + dataset 没有对应声明），
  // 所以只断言"跳转那条在"，不锁死总数
  assert.ok(
    problems.some((p) => /静默失败|switchTab/.test(p)),
    '带 ${} 的模板字符串 url 必须被解析出来，否则跳转检查形同虚设。实际：' + JSON.stringify(problems)
  );
});

test('lint 自测：能识别 async 方法（这里的正则曾经漏了 async）', () => {
  const problems = lintPage({
    rel: 'fake',
    wxml: '<view bindtap="onAsync">点我</view>',
    js: 'Page({\n  async onAsync() {},\n  async load() {},\n});\n',
  });
  assert.deepEqual(problems, [], 'async 方法必须被认出来，否则会报假问题');
});

test('lint 自测：正常的页面不该被误报', () => {
  const problems = lintPage({
    rel: 'fake',
    wxml: `<view wx:for="{{list}}" wx:key="id" data-id="{{item.id}}" bindtap="onTap">{{item.name}}</view>
           <view>{{summary}}</view>
           <input bindinput="onInput" />`,
    js: `Page({
  data: { list: [], summary: '' },
  onTap(e) { const id = e.currentTarget.dataset.id; wx.navigateTo({ url: '/pages/ok/index?id=' + id }); },
  async onInput(e) { this.setData({ summary: e.detail.value }); },
  async load() {},
});`,
    pages: new Set(['/pages/ok/index', '/pages/home/index']),
    tabPages: new Set(['/pages/home/index']),
  });
  assert.deepEqual(problems, []);
});

/* ============================================================
   扫真实页面
   ============================================================ */

test('小程序：所有页面通过静态检查（事件绑定 / wx:key / 跳转 / 模板字段）', () => {
  const pages = declaredPages();
  const tabs = tabPages();
  const all = [];

  for (const dir of pageDirs()) {
    const rel = path.relative(MP, dir).replace(/\\/g, '/');
    const wxmlPath = path.join(dir, 'index.wxml');
    const jsPath = path.join(dir, 'index.js');

    if (!fs.existsSync(jsPath)) continue;   // 纯静态页也允许

    all.push(...lintPage({
      rel,
      wxml: read(wxmlPath),
      js: read(jsPath),
      pages,
      tabPages: tabs,
    }));
  }

  assert.ok(all.length === 0,
    `发现 ${all.length} 个只有真机上才会暴露的问题：\n` + all.map((p) => '  · ' + p).join('\n'));
});

test('小程序：每个页面都在 app.json 里声明了（没有写了却进不去的页面）', () => {
  const declared = declaredPages();
  const orphans = [];

  for (const dir of pageDirs()) {
    const rel = path.relative(MP, dir).replace(/\\/g, '/');
    // app.json 声明的是文件路径，页面目录要补上 /index
    if (!declared.has('/' + rel + '/index')) orphans.push(rel);
  }

  assert.deepEqual(orphans, [],
    '这些页面写了但没在 app.json 里声明，等于永远进不去：\n' + orphans.join('\n'));
});
