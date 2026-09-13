/**
 * 无头浏览器探测（纯函数，便于测试）
 */
import fs from 'node:fs';

/** 常见安装位置，按优先级排列 */
export const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA
    ? process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe'
    : null,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA
    ? process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
    : null,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/**
 * 返回第一个存在的浏览器可执行文件路径，找不到返回 null。
 * @param {string[]} candidates
 * @param {(p: string) => boolean} exists 便于测试时注入
 */
export function pickBrowser(candidates = CANDIDATES, exists) {
  const check = exists || ((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  for (const c of candidates) {
    if (c && check(c)) return c;
  }
  return null;
}
