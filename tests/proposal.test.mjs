/**
 * 提案页验证
 * 这份文件是要打印成 PDF 转发给义卖组织方的，所以必须：
 *   1. 完全自包含（对方双击就能打开打印，不依赖本地服务器和网络）
 *   2. 带 A4 打印样式，且彩色块不会被打印丢色
 *   3. 关键章节齐全，不能漏掉"系统不碰钱"和"换届方案"这两块
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'docs', 'proposal.html');

const html = () => fs.readFileSync(FILE, 'utf8');

test('提案：文件存在', () => {
  assert.ok(fs.existsSync(FILE), 'docs/proposal.html 不存在');
});

test('提案：完全自包含，不引用任何外部资源', () => {
  const src = html();
  const external = [
    ...src.matchAll(/<link[^>]+href="([^"]+)"/gi),
    ...src.matchAll(/<script[^>]+src="([^"]+)"/gi),
    ...src.matchAll(/@import\s+[^;]+;/gi),
  ].map((m) => m[1] || m[0]);

  assert.deepEqual(external, [], '提案页不应引用外部资源：' + external.join(', '));
  assert.ok(!/https?:\/\//.test(src.replace(/xmlns="[^"]*"/g, '')),
    '提案页不应包含任何外部链接');
});

test('提案：带 A4 打印样式，且彩色块能打印出来', () => {
  const src = html();
  assert.match(src, /@page\s*\{\s*size\s*:\s*A4/, '缺少 @page A4 设置');
  assert.match(src, /print-color-adjust\s*:\s*exact/, '缺少 print-color-adjust: exact，彩色块打印会丢色');
  assert.match(src, /@media\s+print/, '缺少 @media print 样式');
  assert.match(src, /\.toolbar\s*\{\s*display\s*:\s*none\s*!important/, '打印时必须隐藏工具条');
  assert.match(src, /page-break-after\s*:\s*always|break-after\s*:\s*page/, '缺少分页规则');
});

test('提案：分成 2 页 A4', () => {
  const sheets = html().match(/class="sheet"/g) || [];
  assert.equal(sheets.length, 2, '应为 2 页 A4');
});

test('提案：三个关键章节都在（不碰钱 / 换届 / 需要对方配合）', () => {
  const src = html();

  // 1. 系统不碰钱——这是说服组织方的核心
  assert.match(src, /不碰钱|不收钱/, '缺少"系统不碰钱"的说明');
  assert.match(src, /不涉及任何线上支付/, '缺少不涉及线上支付的明确表述');

  // 2. 换届转交——社团负责人一定会问
  assert.match(src, /转交超级管理员/, '缺少管理员转交方案');
  assert.match(src, /一级管理员|二级管理员/, '缺少管理员分级说明');

  // 3. 需要对方提供什么
  assert.match(src, /义卖物品清单/, '缺少需要对方提供的信息清单');
  assert.match(src, /摊位设置/, '缺少摊位设置需求');

  // 4. 当天保障与纸质兜底
  assert.match(src, /纸质/, '缺少纸质兜底预案');

  // 5. 备案这一条不能藏起来
  assert.match(src, /备案/, '缺少备案时间的如实说明');
});

test('提案：包含打印按钮与操作提示', () => {
  const src = html();
  assert.match(src, /window\.print\(\)/, '缺少打印按钮');
  assert.match(src, /另存为 PDF/, '缺少"另存为 PDF"的操作提示');
  assert.match(src, /背景图形/, '缺少"勾选背景图形"的提示');
});

test('提案：不出现真实联系方式占位以外的个人信息', () => {
  const src = html();
  // 联系方式留空，由提案人自己填
  assert.match(src, /class="fill"/, '联系方式应留空待填');
  assert.ok(!/1[3-9]\d{9}/.test(src), '不应硬编码手机号');
});
