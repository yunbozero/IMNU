/**
 * 零依赖静态服务器，仅用于本地预览原型。
 * 必须用 HTTP 打开：部分浏览器在 file:// 下会禁用 localStorage，
 * 那样跨页面导航时预定状态会丢失。
 *
 *   npm run serve        # 默认 http://localhost:8080/
 *   PORT=9000 npm run serve
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lanUrls } from './lan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

http
  .createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/prototype/index.html';

    const file = path.join(root, p);
    if (!file.startsWith(root)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 forbidden');
      return;
    }

    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 not found: ' + p);
        return;
      }
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(buf);
    });
  })
  .listen(port, () => {
    const lan = lanUrls(os.networkInterfaces(), port);

    console.log('');
    console.log('  IMNU 校园义卖 · 原型已启动');
    console.log('');
    console.log('  本机演示台：  http://localhost:' + port + '/');

    if (lan.length) {
      console.log('');
      console.log('  同一个 WiFi 下的手机可以打开下面这个地址：');
      for (const l of lan) {
        console.log('      ' + l.url + '   (' + l.iface + ')');
      }
      console.log('');
      console.log('  把它输入手机浏览器，或用微信扫一扫 / 相机扫码。');
    } else {
      console.log('');
      console.log('  未检测到局域网地址，请确认电脑已连上 WiFi。');
    }

    console.log('');
    console.log('  Ctrl+C 停止');
    console.log('');
  });
