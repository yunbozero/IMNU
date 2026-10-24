/**
 * 两个真机上撞到的 bug 的守卫。
 *
 * 1. 「自动登录了，但什么都点不动」——本地还存着上一版体验版的 token，
 *    而服务端已经不认它（过期 / 重新部署换了签名密钥）。界面读缓存显示成已登录，
 *    每个请求却 401。修复要点：401 时必须清掉本地登录态。
 * 2. 取货码键盘的数字偏右 —— 微信 button 默认带左右内边距，把数字挤偏了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(p, 'utf8');

test('登录态：401 时必须清掉本地 session（否则「登录了但点不动」）', () => {
  const session = read(path.join(MP, 'services/session.js'));

  // refreshUser 里遇到 401 要 clearSession，而不是把错往上抛就算了
  const refresh = /export async function refreshUser\(\)[\s\S]*?\n}/.exec(session);
  assert.ok(refresh, '找不到 refreshUser');
  assert.match(refresh[0], /clearSession\(\)/, 'refreshUser 遇到 401 要清掉本地登录态');
  assert.match(refresh[0], /status === 401/, '按 401 判断，不是按任意错误');

  // ensureSession 要能「真的问一次服务端」
  assert.match(session, /export async function ensureSession\(\{ verify = false \} = \{\}\)/,
    'ensureSession 要支持 verify');
  assert.match(session, /await refreshUser\(\)/, 'verify 时要用 refreshUser 去校验');
});

test('登录态：换头像 / 改昵称之前先校验 token', () => {
  const js = read(path.join(MP, 'pages/profile/index.js'));
  assert.match(js, /ensureSession\(\{ verify: true \}\)/, '敏感操作前先确认 token 还有效');
  assert.match(js, /\/api\/me\/name/, '改昵称要走接口');
  assert.match(js, /session\.setUser\(/, '改完要用服务端返回的 user 更新缓存');
});

test('「我的」页：登记过的人不该再看到填名字的框', () => {
  const js = read(path.join(MP, 'pages/profile/index.js'));

  // 本地没登录态时先静默登录一次，已登记就直接恢复
  assert.match(js, /async ensureProfile\(\)/, '需要一个「先登录再决定显示什么」的入口');
  assert.match(js, /await session\.login\(\)/, '要静默登录（不是弹窗让人重新登记）');
  assert.match(js, /r\.registered/, '按「服务端说登记过没有」决定显示');

  // 「未登录」和「未登记」必须分开处理
  assert.match(js, /needRegister: !user/, '表单仍然由 user 是否为空决定（这本身没错）');
  const wxml = read(path.join(MP, 'pages/profile/index.wxml'));
  assert.match(wxml, /清除本机缓存/, '按钮改名：它清的是缓存，不是账号');
  assert.doesNotMatch(wxml, /退出登录/, '别再说「退出登录」—— 会让人以为账号没了');
});

test('取货码键盘：数字用 text 包住，且清掉 button 默认内边距', () => {
  const wxml = read(path.join(MP, 'packageBazaar/pages/scan/index.wxml'));
  assert.match(wxml, /class="keys__num"/, '数字要包一层 text（button 的行高会把字带偏）');

  const wxss = read(path.join(MP, 'app.wxss'));
  const btn = /\.keys__btn \{[\s\S]*?\n\}/.exec(wxss);
  assert.ok(btn, '找不到 .keys__btn');
  assert.match(btn[0], /padding:\s*0/, '微信 button 默认左右内边距会把数字挤偏');
  assert.match(wxss, /\.keys__num \{/, '要有 text 层的行高修正');
});
