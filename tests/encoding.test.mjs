/**
 * 编码守卫。
 *
 * 起因：我用 PowerShell 的 `Set-Content` 重写过两个文件，把里面的中文写成了
 * 非 UTF-8 字节。**这件事一直没被发现**，因为 Node 读文件时会把非法字节
 * 静默替换成 U+FFFD，脚本照常解析、测试照常通过 —— 只有用严格解码的工具
 * 打开才会暴露。
 *
 * 所以需要一条独立的断言：文件必须能通过**严格** UTF-8 解码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocalOnlyFile } from './secrets.test.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEXT_EXT = new Set([
  '.mjs', '.js', '.json', '.md', '.wxml', '.wxss',
  '.sh', '.service', '.timer', '.conf', '.html', '.css', '.txt',
]);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'tmp', 'dist', 'coverage']);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...walk(path.join(dir, e.name)));
    } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

test('编码：所有文本文件都是合法的 UTF-8', () => {  const files = walk(ROOT);
  assert.ok(files.length > 80, `只扫到 ${files.length} 个文件，遍历逻辑可能有问题`);

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const broken = [];

  for (const f of files) {
    try {
      decoder.decode(fs.readFileSync(f));
    } catch {
      broken.push(path.relative(ROOT, f).replace(/\\/g, '/'));
    }
  }

  assert.deepEqual(broken, [],
    '以下文件不是合法 UTF-8，中文很可能已经被写坏（常见原因：用 PowerShell 的 ' +
    'Set-Content 重写文件）：\n' + broken.map((b) => '  · ' + b).join('\n'));
});

test('编码：源码里不该出现替换字符（U+FFFD）', () => {
  // 就算某些工具能容忍非法字节，被替换成 U+FFFD 的中文也是不可逆的丢失
  const files = walk(ROOT).filter((f) => !f.endsWith('.md'));
  const tainted = [];

  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (text.includes('\uFFFD')) tainted.push(path.relative(ROOT, f).replace(/\\/g, '/'));
  }

  assert.deepEqual(tainted, [], '这些文件里有 U+FFFD 替换字符：\n' + tainted.join('\n'));
});

test('编码：中文注释确实还能读通（不是一堆乱码）', () => {
  // 抽查几个关键文件，确认中文是完整的
  const samples = [
    'README.md',
    'server/repository.mjs',
    'server/roles.mjs',
    'tests/all.mjs',
    'miniprogram/app.json',
  ];

  for (const rel of samples) {
    const p = path.join(ROOT, rel);
    assert.ok(fs.existsSync(p), `抽查的文件不存在：${rel}`);
    const text = fs.readFileSync(p, 'utf8');
    assert.match(text, /[\u4e00-\u9fa5]{2,}/, `${rel} 里找不到连续中文，可能被写坏了`);
  }
});

test('编码：换行必须是 LF（CRLF 会混进 diff，Linux 上还会出怪问题）', () => {
  // 起因：我用 PowerShell 的 `[System.IO.File]::WriteAllLines` 删了几行，
  // 它在 Windows 上默认写 CRLF，于是整个文件的行尾全变了。
  // git 当时只给了一句 warning（`.gitattributes` 会在下次接触时转回 LF），
  // 很容易划过去 —— 但工作区里那份就是 CRLF，后续 diff 全是噪音。
  //
  // `.gitattributes` 写的是 `* text=auto eol=lf`，只有 Windows 专用的
  // .ps1/.bat/.cmd 例外。这里按同一条规则查。
  const CRLF_OK = /\.(ps1|bat|cmd)$/i;

  const bad = [];
  for (const f of walk(ROOT)) {
    if (CRLF_OK.test(f)) continue;
    // ★ 跳过「只属于本机、永远不会提交」的文件。
    //   微信开发者工具生成的 project.private.config.json 就是 CRLF ——
    //   它不是仓库的一部分，拿仓库的规矩去要求它只会让测试常红。
    //   （哪些文件算本机文件、以及它们必须真被 .gitignore 挡住，
    //   由 tests/secrets.test.mjs 负责，这里直接复用同一个判断。）
    if (isLocalOnlyFile(path.basename(f))) continue;

    if (fs.readFileSync(f).includes(Buffer.from('\r\n'))) {
      bad.push(path.relative(ROOT, f).replace(/\\/g, '/'));
    }
  }

  assert.deepEqual(bad, [],
    '以下文件用了 CRLF 换行（应当是 LF）。'
    + '常见原因：用 PowerShell 的 Set-Content / WriteAllLines 重写了文件 —— '
    + '要用编辑器改，或者写完转一次：\n' + bad.map((b) => '  · ' + b).join('\n'));
});
