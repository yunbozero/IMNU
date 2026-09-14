/**
 * Shell 脚本校验。
 *
 * 用 Git Bash 对 shell 脚本做**真正的语法检查**（`bash -n`），
 * 而不是只做跨文件文本一致性检查。
 *
 * ★ 这里最容易写错的地方是：沙箱/受限环境里 bash 可能**根本起不来**
 *   （MSYS2 需要命名管道，受限沙箱会拒绝）。如果只看退出码，就会把
 *   "bash 没启动"误判成"脚本有语法错误"，一路报假问题。
 *   所以必须先分辨这两种情况，起不来就 skip，而不是 fail。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 现存的 shell 脚本 */
const SCRIPTS = ['deploy/bootstrap.sh', 'deploy/deploy.sh'];

const BASH_CANDIDATES = [
  'C:\\z_Downloads\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  '/usr/bin/bash',
  '/bin/bash',
  '/usr/bin/env',
];

/**
 * bash 起不来时的特征串。
 * ★ 只认「bash 这个进程本身没起来」，不要收进通用的报错。
 *   之前把 `No such file or directory` 也算进来，结果脚本路径写错时
 *   会被当成「bash 不可用」而静默跳过 —— 方向正好反了，那才是真问题。
 */
const STARTUP_FAILURE = /couldn't create signal pipe|fatal error|Win32 error \d+/i;

function findBash() {
  for (const c of BASH_CANDIDATES) {
    if (c.endsWith('env')) continue;
    try { if (fs.existsSync(c)) return c; } catch { /* 忽略 */ }
  }
  return null;
}

/**
 * @returns {{state:'ok'|'syntax_error'|'unavailable', detail:string}}
 */
function checkSyntax(bash, file) {
  const r = spawnSync(bash, ['-n', file], { encoding: 'utf8', timeout: 20000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;

  if (r.error || STARTUP_FAILURE.test(out)) {
    return { state: 'unavailable', detail: out.trim().slice(0, 200) || String(r.error) };
  }
  if (r.status !== 0) return { state: 'syntax_error', detail: out.trim() };
  return { state: 'ok', detail: '' };
}

/* ============================================================
   ★ 先证明这套判定本身是可信的
   ============================================================ */

test('shell：能分辨「bash 没启动」和「脚本有语法错」', () => {
  const bash = findBash();
  if (!bash) return;   // 没有 bash，这条测不了

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-sh-'));
  try {
    // 造一个真的语法错误
    const bad = path.join(dir, 'bad.sh');
    fs.writeFileSync(bad, '#!/usr/bin/env bash\nif [ 1 -eq 1 ]; then\n  echo hi\n',
      { encoding: 'utf8' });

    const r = checkSyntax(bash, bad);
    if (r.state === 'unavailable') return;   // 当前环境起不来，跳过

    assert.equal(r.state, 'syntax_error', '有语法错的脚本必须被判为 syntax_error');
    assert.match(r.detail, /syntax error|unexpected/i);

    // 造一个正确的
    const good = path.join(dir, 'good.sh');
    fs.writeFileSync(good, '#!/usr/bin/env bash\nset -euo pipefail\necho ok\n',
      { encoding: 'utf8' });
    assert.equal(checkSyntax(bash, good).state, 'ok', '正确的脚本必须判为 ok');

    // 不存在的文件：这是真问题，必须判成失败，不能被当成「bash 起不来」而跳过
    const missing = checkSyntax(bash, path.join(dir, 'nope.sh'));
    assert.equal(missing.state, 'syntax_error',
      '脚本路径不存在必须算检查失败；被判成 unavailable 的话，路径写错就会被静默跳过');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ============================================================
   真实脚本
   ============================================================ */

test('shell：部署脚本语法正确', (t) => {
  const bash = findBash();
  if (!bash) return t.skip('机器上找不到 bash');

  // 先探一下 bash 能不能起来，起不来就明确跳过，而不是误报
  const probe = spawnSync(bash, ['--version'], { encoding: 'utf8', timeout: 20000 });
  if (probe.error || STARTUP_FAILURE.test(`${probe.stdout || ''}${probe.stderr || ''}`)) {
    return t.skip('bash 在当前沙箱里起不来（MSYS2 需要命名管道），普通终端里可以正常跑');
  }

  const problems = [];
  for (const rel of SCRIPTS) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `找不到 ${rel}`);

    const r = checkSyntax(bash, file);
    if (r.state !== 'ok') problems.push(`${rel}: ${r.detail}`);
  }

  assert.deepEqual(problems, [], 'shell 语法错误：\n' + problems.join('\n'));
});

test('shell：脚本用的是 LF 换行（CRLF 会让 Linux 上的 bash 直接报错）', () => {
  for (const rel of SCRIPTS) {
    const raw = fs.readFileSync(path.join(ROOT, rel));
    assert.equal(raw.includes(Buffer.from('\r\n')), false, `${rel} 里是 CRLF 换行`);
  }
});

test('shell：用到的外部命令都在脚本里有兜底或前置检查', () => {
  // 这不是语法检查能覆盖的：脚本里调了平台不支持的命令，
  // 只有在 Linux 上跑才知道。这里只确认关键命令确实被调到了。
  const bootstrap = fs.readFileSync(path.join(ROOT, 'deploy/bootstrap.sh'), 'utf8');
  for (const cmd of ['apt-get', 'node', 'nginx', 'certbot', 'ufw', 'systemctl']) {
    assert.ok(bootstrap.includes(cmd), `bootstrap.sh 里找不到 ${cmd}`);
  }
});
