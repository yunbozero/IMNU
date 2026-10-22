/**
 * 页面「状态」守卫：空态 / 错误态 / 定时器 / 时间戳。
 *
 * 这几类问题的共同点是**本地不报错、真机上只是表现得很奇怪**：
 *   - 空态没排除错误态 → 接口一挂，页面上「加载失败」和「这里还没有记录」同时出现
 *   - 时间戳直接进模板 → 已取货的状态条上显示「· 1712345678901」
 *   - 定时器不落账     → 用户提前返回时，那个还没触发的 navigateBack 会**多退一层**
 *   - 核销台连点       → 同一个码提交两次，第二次「已核销」红字让人以为第一单没成功
 *
 * 全部是纯静态能查出来的，所以放在这里，不等到真机上才发现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(p, 'utf8');
const rel = (p) => path.relative(MP, p).replace(/\\/g, '/');

/** 递归收集某个后缀的文件（不含 node_modules 之类，这里没有） */
function walkFiles(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full, ext));
    else if (e.name.endsWith(ext)) out.push(full);
  }
  return out;
}

const WXML = walkFiles(MP, '.wxml');
const JS = walkFiles(MP, '.js');

/**
 * 时间戳字段只允许以格式化后的 `xxxText` 出现。
 *
 * `redeemedAt` / `createdAt` 这些是毫秒数 —— 模板里直接写就是把数字丢给学生看。
 */
test('页面：时间戳字段不能直接进模板（必须先格式化）', () => {
  const problems = [];

  for (const file of WXML) {
    const src = read(file);
    for (const m of src.matchAll(/\{\{[^}]*?\.(redeemedAt|createdAt|cancelledAt|updatedAt)\s*\}\}/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      problems.push(`${rel(file)}:${line} 直接渲染 ${m[1]}（毫秒时间戳）—— 先用 timeText() 变成文本`);
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});

/**
 * 空态的条件必须排除 error。
 *
 * 否则接口一挂，页面上会同时出现「加载失败：…」和「这里还没有物品」——
 * 后者是错的：不是没有，是没读到。
 *
 * 判据只针对「自己带 `!loading` 条件的空态」：那种写法想表达的就是
 * 「加载完了，但列表是空的」，漏掉 `!error` 才是 bug。
 * 反过来，条件本来就不是加载状态（`wx:if="{{offline}}"`）或者空态嵌在
 * 一个条件块里（`wx:elif="{{missing}}"` 的子元素），都算表达清楚了。
 */
function scanEmptyStates(src) {
  const problems = [];
  const stack = [];   // 每层：这个元素有没有开条件块

  const VOID = new Set(['image', 'input', 'icon', 'canvas', 'text', 'switch', 'slider']);
  const tagRe = /<(\/?)([a-zA-Z-]+)([^>]*)>/g;
  let m;

  while ((m = tagRe.exec(src))) {
    const [, closing, name, attrs] = m;
    if (closing) { stack.pop(); continue; }

    const selfClosing = /\/\s*$/.test(attrs) || VOID.has(name);
    const hasCond = /\bwx:(if|elif|else)\b/.test(attrs);
    const line = src.slice(0, m.index).split('\n').length;

    if (/\bclass="[^"]*\bempty\b[^"]*"/.test(attrs)) {
      const cond = /wx:if="([^"]*)"/.exec(attrs);
      // wx:elif / wx:else 本身就是在条件链里，不需要再挂 wx:if
      const inChain = /\bwx:(?:elif|else)\b/.test(attrs);
      if (cond && /!\s*loading/.test(cond[1]) && !/!\s*error/.test(cond[1])) {
        problems.push(`${line}: 空态条件缺 !error：「${cond[1]}」`);
      } else if (!cond && !inChain && !stack.some((s) => s.hasCond)) {
        problems.push(`${line}: 空态既没有自己的条件，也不在任何条件块里`);
      }
    }

    if (!selfClosing) stack.push({ hasCond });
  }

  return problems;
}

test('页面：空态不能和错误态同时出现', () => {
  const problems = [];

  for (const file of WXML) {
    for (const p of scanEmptyStates(read(file))) problems.push(`${rel(file)}:${p}`);
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});

/**
 * 错误条要能点一下重试。
 *
 * 例外只有一处：`admin/cancel` 的错误来自业务判断（没带 id、找不到这一笔、
 * 没有权限），重试没有意义 —— 它照样把话说清楚，只是不挂重试。
 */
test('页面：错误条要能点一下重试', () => {
  const ALLOW = new Set(['packageAdmin/pages/cancel/index.wxml']);
  const problems = [];

  for (const file of WXML) {
    const src = read(file);
    for (const m of src.matchAll(/<view[^>]*class="notice notice--strong"[^>]*>[^<]*\{\{error\}\}/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      if (ALLOW.has(rel(file))) continue;
      if (!/bindtap=/.test(m[0])) {
        problems.push(`${rel(file)}:${line} 错误条没有 bindtap 重试入口`);
      }
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});

/**
 * setTimeout 必须落账（`this._xxx = setTimeout(...)`），并且要有对应的 clearTimeout。
 *
 * 不落账的后果很具体：延时里 `navigateBack()` 会在用户已经手动返回之后再执行一次，
 * 把上一页也退掉；页面卸载后还在跑的定时器还会多发一次请求。
 */
test('页面：setTimeout 必须落账，且卸载时要清掉', () => {
  const problems = [];

  for (const file of JS) {
    const src = read(file);

    // ① 每一处 setTimeout 都要被接住（赋值给变量）
    for (const m of src.matchAll(/setTimeout\s*\(/g)) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const lineEnd = src.indexOf('\n', m.index);
      const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (!/=\s*setTimeout\s*\(/.test(line)) {
        problems.push(`${rel(file)}:${src.slice(0, m.index).split('\n').length} setTimeout 没有落账 —— 卸载时清不掉`);
      }
    }

    // ② 落在 this._xxx 上的定时器，文件里必须有 clearTimeout(this._xxx)
    for (const m of src.matchAll(/this\.(_\w+)\s*=\s*setTimeout\s*\(/g)) {
      const name = m[1];
      if (!new RegExp(`clearTimeout\\(this\\.${name}`).test(src)) {
        problems.push(`${rel(file)}: this.${name} 从没被 clearTimeout —— 页面卸载后还会触发`);
      }
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});
