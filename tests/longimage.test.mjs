/**
 * 微信长图验证
 * 两张长图（学生端 / 管理端）是给组织方看的门面，必须：
 *   1. 源文件齐全、引用不外链、脚本语法正确
 *   2. 每张图都覆盖了该端的关键屏，且顺序与真实流程一致
 *   3. PNG 真的生成出来了
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const read = (p) => fs.readFileSync(p, 'utf8');

const PAGES = {
  student: 'longimage-student.html',
  admin: 'longimage-admin.html',
};

/** 从 PNG 头部读出宽高，不需要解码器 */
function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.subarray(1, 4).toString('ascii'), 'PNG', '不是 PNG 文件');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test('长图：源文件与共用资源齐全', () => {
  for (const f of [...Object.values(PAGES), 'longimage.css', 'longimage.js']) {
    assert.ok(fs.existsSync(path.join(DOCS, f)), `缺少 docs/${f}`);
  }
});

test('长图：不引用任何外部资源，且内链都存在', () => {
  const problems = [];
  for (const f of Object.values(PAGES)) {
    const src = read(path.join(DOCS, f));
    for (const [, url] of src.matchAll(/(?:href|src|data-src)="([^"]+)"/g)) {
      if (/^(https?:|data:|#)/.test(url)) {
        problems.push(`${f} 引用了外部资源：${url}`);
        continue;
      }
      const clean = url.split('?')[0].replace(/&amp;/g, '&').split('&')[0];
      if (!clean || clean.indexOf('__RID__') >= 0) continue;
      const resolved = path.resolve(DOCS, clean);
      if (!fs.existsSync(resolved)) {
        problems.push(`${f} → ${url} 不存在`);
      }
    }
  }
  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

test('长图：共用脚本语法正确，且同步上报页面高度', () => {
  const code = read(path.join(DOCS, 'longimage.js'));
  assert.doesNotThrow(() => new vm.Script(code, { filename: 'longimage.js' }));
  assert.match(code, /data-page-height/, '必须把页面高度写进 DOM 供截图脚本读取');
  assert.ok(!/requestAnimationFrame/.test(code),
    '高度必须在同步阶段读取，不能依赖 requestAnimationFrame（截图时会来不及）');
});

test('长图：学生端覆盖 浏览 → 预定 → 成功 → 取货码 四屏', () => {
  const src = read(path.join(DOCS, PAGES.student));
  const order = ['s2-items', 's3-item-detail', 's5-success', 's7-pickup-code'];
  let last = -1;
  for (const p of order) {
    const i = src.indexOf(p);
    assert.ok(i > last, `学生端缺少 ${p} 或顺序不对`);
    last = i;
  }
  assert.match(src, /系统只锁名额/, '学生端必须出现"系统只锁名额"的收尾结论');
});

test('长图：管理端覆盖 核销台 → 输码 → 成功 → 重复核销 四屏', () => {
  const src = read(path.join(DOCS, PAGES.admin));
  assert.match(src, /v1-scan\.html"/, '缺少核销台');
  assert.match(src, /v1-scan\.html\?pad=1/, '缺少手动输码弹层');
  assert.match(src, /v3-result\.html\?rid=/, '缺少核销成功');
  assert.match(src, /v3-result\.html\?err=redeemed/, '缺少重复核销拦截');
  assert.match(src, /核销前先确认已收款/, '必须提醒先收款再交付');
});

test('长图：引用原型页面时隐藏了演示用的脚手架提示', () => {
  const js = read(path.join(DOCS, 'longimage.js'));
  assert.match(js, /demo-hint/, '长图里不应出现"演示提示"这类只有开发才需要的内容');
});

test('长图：PNG 已生成，且是 2 倍图（宽 750）', () => {
  for (const [name, file] of [['学生端', 'longimage-student.png'], ['管理端', 'longimage-admin.png']]) {
    const p = path.join(DOCS, file);
    assert.ok(fs.existsSync(p), `${name}长图 ${file} 还没生成，请运行 npm run longimage`);

    const { w, h } = pngSize(p);
    assert.equal(w, 750, `${name}长图宽度应为 750（2 倍图）`);
    assert.ok(h > 3000 && h < 12000, `${name}长图高度 ${h} 不在合理范围`);
  }
});
