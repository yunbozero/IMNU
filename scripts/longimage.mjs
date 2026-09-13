/**
 * 把 docs/longimage-*.html 渲染成微信长图 PNG。
 *
 *   npm run longimage
 *
 * 流程：起一个临时静态服务 → 无头 Edge/Chrome 量出页面实际高度 → 按该高度截图。
 * 之所以走 HTTP 而不是 file://：长图里的 iframe 要加载真实原型页面，
 * 并且需要与父页面同源才能共享 localStorage 里的演示状态。
 *
 * 注意：每次运行都用全新的 user-data-dir。复用同一个目录时，如果上一次
 * 浏览器进程没有正常退出，profile 会被锁住，导致后续启动直接卡死。
 */
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBrowser } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const PORT = Number(process.env.PORT || 8177);

const CSS_WIDTH = 375;   // 页面按一部手机的宽度排版
const SCALE = 2;         // 2 倍图，输出 750px 宽

const POSTERS = [
  { file: 'longimage-student.html', out: 'longimage-student.png', label: '学生端' },
  { file: 'longimage-admin.html', out: 'longimage-admin.png', label: '管理端' },
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/docs/' + POSTERS[0].file;
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const browser = pickBrowser();
if (!browser) {
  console.error('找不到 Edge 或 Chrome，无法生成长图。');
  console.error('请安装 Microsoft Edge 或 Google Chrome，或手动打开 docs/longimage-*.html 截图。');
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-shot-'));
console.log('浏览器：' + browser);

const server = await serve();
console.log('临时服务：http://127.0.0.1:' + PORT + '/');
console.log('');

let failed = 0;

try {
  for (const { file, out, label } of POSTERS) {
    const url = `http://127.0.0.1:${PORT}/docs/${file}`;
    const profile = path.join(scratch, label);       // 每次全新 profile，避免被锁
    const target = path.join(DOCS, out);

    const flags = [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--no-first-run', '--disable-extensions',
      `--user-data-dir=${profile}`,
      `--force-device-scale-factor=${SCALE}`,
    ];

    // ---------- 一、量高度 ----------
    const probe = spawnSync(
      browser,
      [...flags, `--window-size=${CSS_WIDTH},1000`, '--dump-dom', url],
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 90000 }
    );
    const m = (probe.stdout || '').match(/data-page-height="(\d+)"/);
    if (!m) {
      console.error(`✗ ${label}：读不到页面高度`);
      console.error((probe.stderr || probe.stdout || '').slice(-600));
      failed++;
      continue;
    }
    const height = Number(m[1]);

    // ---------- 二、按高度截图 ----------
    fs.rmSync(target, { force: true });
    spawnSync(
      browser,
      [...flags, `--window-size=${CSS_WIDTH},${height}`, `--screenshot=${target}`, url],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 }
    );

    if (!fs.existsSync(target)) {
      console.error(`✗ ${label}：截图失败`);
      failed++;
      continue;
    }
    const { w, h } = pngSize(target);
    const kb = (fs.statSync(target).size / 1024).toFixed(0);
    console.log(`✅ ${label}  docs/${out}   ${w} × ${h}   ${kb} KB`);
  }
} finally {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}

if (failed) {
  console.error('');
  console.error(`${failed} 张长图生成失败。`);
  process.exit(1);
}
console.log('');
console.log('长图已就绪，可直接转发到微信。');
