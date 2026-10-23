/**
 * 文档不许再漂。
 *
 * 这个仓库的接口文档（docs/api.md）以前是"想起来才更新"的，
 * 结果缺了 9 个接口、还有 3 处写着"还没做"其实早做完了 ——
 * 交接时照着文档看，会以为系统比实际简陋得多。
 *
 * 这里做两件事（都很便宜，纯文本比对）：
 *   1. http.mjs 里注册的每个路由，都必须在 docs/api.md 里出现
 *   2. docs/api.md 里提到的每个 /api/... 路径，都必须是真实存在的路由
 *      （防止文档写了接口但根本没实现 —— 那种更坑）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTTP = fs.readFileSync(path.join(ROOT, 'server', 'http.mjs'), 'utf8');
const API_MD = fs.readFileSync(path.join(ROOT, 'docs', 'api.md'), 'utf8');

/** 从 http.mjs 的 ROUTES 表里抠出所有路径（只要路径，方法另算） */
function routesInCode() {
  const out = new Set();
  const re = /'([A-Z]+)\s+(\/api\/[^']+)'/g;
  let m;
  while ((m = re.exec(HTTP)) !== null) out.add(m[2]);
  return out;
}

/** 从文档里抠出所有 /api/... 路径 */
function routesInDocs() {
  const out = new Set();
  const re = /\/api\/[a-zA-Z0-9/_-]+/g;
  let m;
  while ((m = re.exec(API_MD)) !== null) out.add(m[0].replace(/[.,;)]+$/, ''));
  return out;
}

test('文档：代码里注册的每个接口都要写进 docs/api.md', () => {
  const documented = routesInDocs();
  const missing = [...routesInCode()].filter((r) => !documented.has(r)).sort();

  assert.deepEqual(missing, [],
    `这些接口实现了但文档里没有：${missing.join('、')}\n`
    + '（补进 docs/api.md；别删这条测试 —— 文档漂移就是这么来的）');
});

test('文档：文档里提到的每个接口都必须真的存在', () => {
  const code = routesInCode();
  const bogus = [...routesInDocs()].filter((r) => !code.has(r)).sort();

  assert.deepEqual(bogus, [],
    `文档里写了这些接口，但 http.mjs 里没有：${bogus.join('、')}\n`
    + '（要么补实现，要么把它改成"还没做"的说明，别留着看起来像能用）');
});

test('文档：接口一览的条数要和代码对得上（防止漏了「一览表」）', () => {
  const documented = routesInDocs();
  const code = routesInCode();
  // 文档里总会多出一些"示例里顺便提到"的路径，所以只查代码里的都覆盖到
  assert.ok(documented.size >= code.size,
    `文档提到 ${documented.size} 个路径，代码有 ${code.size} 个 —— 少了 ${code.size - documented.size} 个`);
});
