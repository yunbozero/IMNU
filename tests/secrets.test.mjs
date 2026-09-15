/**
 * 密钥扫描。
 *
 * 为什么要做成常驻测试：这个仓库准备改成公开，而"我检查过没有密钥"这种话
 * 靠不住 —— 第一次写的扫描器就有 bug，对着埋进去的假密钥报了"干净"。
 * 把它固化成测试，并且**自带自测**，才能保证它真的在查。
 *
 * 扫描的是工作区文件（用 fs 读，不起子进程），所以在受限环境里也能跑。
 * 历史提交另外单独扫一次，见文件末尾的说明。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ============================================================
   规则
   ============================================================ */

export const RULES = [
  {
    name: '私钥文件内容',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    name: 'GitHub token',
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  },
  {
    name: '阿里云 AccessKey',
    re: /\bLTAI[A-Za-z0-9]{12,}\b/,
  },
  {
    name: '微信 AppID',
    // 真实的 AppID 形如 wx + 16 位十六进制
    re: /\bwx[0-9a-f]{16}\b/,
  },
  {
    name: '密钥被赋了真值',
    // 只认「赋值给一个看起来像真值的字符串」，空值和 $(命令) 都不算
    re: /\b(SESSION_SECRET|WX_SECRET|WX_APPID|APP_SECRET|AppSecret|accessKeySecret|SECRET_KEY)\s*[:=]\s*['"][A-Za-z0-9/+_\-]{12,}['"]/i,
  },
  {
    name: '服务器 IP（不该进公开仓库）',
    re: /\b112\.125\.19\.187\b/,
  },
  {
    name: '手机号',
    re: /(?<![\d.])1[3-9]\d{9}(?![\d.])/,
  },
  {
    name: '身份证号',
    re: /(?<![\d])\d{17}[\dXx](?![\d])/,
  },
];

/** 只扫文本文件，且跳过这些目录 */
const TEXT_EXT = new Set([
  '.mjs', '.js', '.json', '.md', '.wxml', '.wxss',
  '.sh', '.service', '.timer', '.conf', '.html', '.css', '.txt',
]);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'tmp', 'dist', 'coverage']);

export function walk(dir) {
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

/** 在文本里找所有命中，返回 [{rule, matched}] */
export function scanText(text) {
  const hits = [];
  for (const r of RULES) {
    const m = text.match(r.re);
    if (m) hits.push({ rule: r.name, matched: m[0] });
  }
  return hits;
}

/* ============================================================
   ★ 先证明扫描器真的会抓
   ============================================================ */

test('密钥扫描器自测：每一种规则都能抓到假样本', () => {
  // ★ 样本必须在源码里拆成几段再拼。
  //   直接写整串的话，扫描器会扫到自己的测试数据而误报；
  //   而"排除本文件"又等于在扫描器上留一个洞 —— 拆开拼就没这个问题。
  const J = (...parts) => parts.join('');

  const samples = [
    ['私钥文件内容', J('-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIEowIBAAKCAQEA')],
    ['GitHub token', J('token = ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789')],
    ['阿里云 AccessKey', J('LTAI', '5tAbCdEfGhIjKlMnOpQr')],
    ['微信 AppID', J('wx', '0123456789abcdef')],
    ['密钥被赋了真值', J("SESSION_SECRET = '", 'deadbeefdeadbeef1234567890ab', "'")],
    ['服务器 IP（不该进公开仓库）', J('curl http://112.125.', '19.187/api/health')],
    ['手机号', J('联系 138', '12345678 咨询')],
    ['身份证号', J('证件号 110101', '199003071234')],
  ];

  for (const [expectedRule, sample] of samples) {
    const hits = scanText(sample);
    assert.ok(
      hits.some((h) => h.rule === expectedRule),
      `规则「${expectedRule}」没抓到样本：${sample}`
    );
  }
});

test('密钥扫描器自测：拼接的样本在源码里确实不成形', () => {
  // 上一条用拼接绕过了自扫描，这里反过来确认拼接真的生效了 ——
  // 不然哪次手滑写成整串，扫描器就又开始误报自己了。
  const own = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.deepEqual(scanText(own), [],
    '扫描器自己的源码里不该有成形样本');
});

test('密钥扫描器自测：正常的占位符和空值不该误报', () => {
  const clean = [
    'SESSION_SECRET=',
    'WX_APPID=${WX_APPID}',
    'SESSION_SECRET=$(openssl rand -hex 32)',
    'const SESSION_SECRET = process.env.SESSION_SECRET;',
    '请把 <你的openid> 填进去',
    'openssl rand -hex 32',
    '// 测试里用的假学号 2021123456',
    'Markdown 里正常讨论 SESSION_SECRET 这个词',
  ];
  for (const s of clean) {
    assert.deepEqual(scanText(s), [], `不该误报：${s}`);
  }
});

/* ============================================================
   扫真实仓库
   ============================================================ */

test('密钥扫描：仓库里没有任何真实密钥或个人敏感信息', () => {
  const files = walk(ROOT);
  assert.ok(files.length > 80, `只扫到 ${files.length} 个文件，遍历逻辑可能有问题`);

  const problems = [];
  for (const f of files) {
    const hits = scanText(fs.readFileSync(f, 'utf8'));
    for (const h of hits) {
      problems.push(`${path.relative(ROOT, f).replace(/\\/g, '/')} → ${h.rule}：${h.matched.slice(0, 60)}`);
    }
  }

  assert.deepEqual(problems, [],
    '发现疑似密钥或敏感信息（仓库准备公开，必须处理）：\n' +
    problems.map((p) => '  · ' + p).join('\n'));
});

test('密钥扫描：.gitignore 必须挡住环境变量文件', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const p of ['.env', '*.key', 'secrets*.json']) {
    assert.ok(ignore.includes(p), `.gitignore 应当包含 ${p}`);
  }
});

test('密钥扫描：全部 git 历史里也没有密钥（含已删除的文件）', (t) => {
  // 只扫工作区是不够的：早期提交里可能有过密钥，即使后来删掉了，
  // 它在历史里依然可查 —— 而公开仓库的历史是能被翻的。
  let diff;
  try {
    diff = execFileSync('git', ['log', '-p', '--all', '--no-color'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    // 受限沙箱不让起子进程。跳过而不是失败 —— 否则会因为"环境跑不了"
    // 报出一个和密钥毫无关系的错误。
    return t.skip('当前环境起不了子进程，无法扫描 git 历史');
  }

  assert.ok(diff.length > 1000, 'git 历史输出太短，命令可能没生效');

  const problems = [];
  for (const r of RULES) {
    const m = diff.match(new RegExp(r.re.source, r.re.flags.includes('i') ? 'gi' : 'g'));
    if (m) problems.push(`${r.name}：${m.length} 处，例如 ${m[0].slice(0, 60)}`);
  }

  assert.deepEqual(problems, [],
    'git 历史里发现疑似密钥：\n' + problems.map((p) => '  · ' + p).join('\n'));
});
