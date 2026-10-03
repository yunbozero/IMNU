/**
 * 小程序骨架校验。
 *
 * 本地没有微信开发者工具，跑不了真机预览，所以验收方式是把
 * **微信的硬性规则**和**前后端契约**都变成断言。
 *
 * 这里挡住的都是「不写测试就一定会踩、而且报错信息完全指不到真正原因」的坑：
 *   - tabBar 页面必须在主包，不能指向分包
 *   - 主包不能 require 分包的文件（反过来可以）
 *   - 小程序调用的接口，后端必须真的存在
 *   - 混用 require 和 import
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES } from '../server/http.mjs';
import { ROLES, canRedeem, canManage, canAdminister } from '../server/roles.mjs';
import {
  ITEM_NAME_MAX, ITEM_DESC_MAX, ITEM_QUOTA_MAX, ITEM_EMOJI_MAX, ITEM_TINTS,
} from '../server/api.mjs';
import { ROLES_CAN_REDEEM, ROLES_CAN_MANAGE, ROLES_CAN_ADMINISTER, ROLE_LABEL } from '../miniprogram/services/session.js';
import * as itemForm from '../miniprogram/packageAdmin/utils/item-form.js';
import { pickBaseUrl, API_BASE } from '../miniprogram/config.js';
import {
  REASONS, OTHER_KEY, REASON_MIN, REASON_MAX, composeReason,
} from '../miniprogram/packageAdmin/utils/cancel-reason.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

/** 递归收集文件 */
function walk(dir, filter = () => true) {
  if (!exists(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

const appJson = () => JSON.parse(read(path.join(MP, 'app.json')));

const jsFiles = () => walk(MP, (f) => f.endsWith('.js'));
const allSourceFiles = () => walk(MP, (f) => /\.(js|wxml|wxss|json)$/.test(f));

/* ============================================================
   ★ 微信的硬性规则
   ============================================================ */

test('小程序：app.json 合法，且声明的每个页面都齐全', () => {
  const cfg = appJson();
  const declared = [
    ...cfg.pages.map((p) => ({ full: p, pkg: 'main' })),
    ...cfg.subPackages.flatMap((sp) =>
      sp.pages.map((p) => ({ full: `${sp.root}/${p}`, pkg: sp.root }))
    ),
  ];

  assert.ok(declared.length >= 8, '页面太少了，检查一下是不是漏声明了');

  const problems = [];
  for (const { full } of declared) {
    // 页面至少要有 .js 和 .wxml，缺一个开发者工具就会报错
    for (const ext of ['.js', '.wxml']) {
      if (!exists(path.join(MP, full + ext))) problems.push(`缺少 ${full}${ext}`);
    }
  }
  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

test('小程序：tabBar 页面必须在主包内（不能指向分包）', () => {
  const cfg = appJson();
  const subRoots = cfg.subPackages.map((s) => s.root);

  for (const item of cfg.tabBar.list) {
    assert.ok(cfg.pages.includes(item.pagePath),
      `tabBar 的 ${item.pagePath} 不在主包 pages 里 —— 微信不允许 tabBar 指向分包页面`);

    for (const root of subRoots) {
      assert.ok(!item.pagePath.startsWith(root + '/'),
        `${item.pagePath} 落在分包 ${root} 里，tabBar 不能这么写`);
    }
  }
});

test('小程序：主包不能引用分包的文件（反过来可以）', () => {
  const cfg = appJson();
  const subRoots = cfg.subPackages.map((s) => s.root);
  const problems = [];

  for (const file of jsFiles()) {
    const rel = path.relative(MP, file).replace(/\\/g, '/');
    const inSub = subRoots.find((r) => rel.startsWith(r + '/'));
    if (inSub) continue;                        // 分包引用谁都可以

    for (const [, spec] of read(file).matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (!spec.startsWith('.')) continue;      // 只看相对路径
      const resolved = path.resolve(path.dirname(file), spec);
      const resolvedRel = path.relative(MP, resolved).replace(/\\/g, '/');
      if (subRoots.some((r) => resolvedRel.startsWith(r + '/'))) {
        problems.push(`${rel} 引用了分包文件 ${spec}`);
      }
    }
  }

  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

test('小程序：所有相对 import 都能解析到真实文件', () => {
  const problems = [];

  for (const file of jsFiles()) {
    for (const [, spec] of read(file).matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      if (!exists(resolved) && !exists(resolved + '.js')) {
        problems.push(`${path.relative(MP, file)} → ${spec} 不存在`);
      }
    }
  }

  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

test('小程序：不许混用 require 和 import（我在这里栽过一次）', () => {
  const problems = [];

  for (const file of jsFiles()) {
    const src = read(file);
    if (/^\s*import\s/m.test(src) && /\brequire\s*\(/.test(src)) {
      problems.push(path.relative(MP, file));
    }
  }

  assert.deepEqual(problems, [],
    '这些文件同时用了 import 和 require，小程序里会报错：\n' + problems.join('\n'));
});

/* ============================================================
   ★ 前后端契约：小程序调用的接口，后端必须真的有
   ============================================================ */

test('小程序：调用的每个接口都在后端路由表里', () => {
  const known = new Set(Object.values(ROUTES).length ? Object.keys(ROUTES).map((k) => k.split(' ')[1]) : []);
  assert.ok(known.size >= 8, '路由表读取异常');

  const used = new Map();   // path -> 出现的位置
  for (const file of jsFiles()) {
    for (const [, apiPath] of read(file).matchAll(/['"](\/api\/[a-z0-9/-]+)['"]/g)) {
      if (!used.has(apiPath)) used.set(apiPath, []);
      used.get(apiPath).push(path.relative(MP, file));
    }
  }

  assert.ok(used.size > 0, '没扫到任何接口调用，正则可能失效了');

  const unknown = [];
  for (const [apiPath, where] of used) {
    if (!known.has(apiPath)) unknown.push(`${apiPath}（出现在 ${[...new Set(where)].join(', ')}）`);
  }

  assert.deepEqual(unknown, [],
    '小程序调用了后端没有的接口：\n' + unknown.join('\n') +
    '\n后端现有：' + [...known].sort().join(', '));
});

test('小程序：每个接口调用的 HTTP 方法也要对得上', () => {
  const methods = new Map();   // path -> Set(方法)
  for (const key of Object.keys(ROUTES)) {
    const [m, p] = key.split(' ');
    if (!methods.has(p)) methods.set(p, new Set());
    methods.get(p).add(m);
  }

  const problems = [];
  for (const file of jsFiles()) {
    const src = read(file);
    for (const [, fn, apiPath] of src.matchAll(/\bapi\.(get|post)\s*\(\s*['"](\/api\/[a-z0-9/-]+)['"]/g)) {
      const method = fn === 'get' ? 'GET' : 'POST';
      const allowed = methods.get(apiPath);
      if (allowed && !allowed.has(method)) {
        problems.push(`${path.relative(MP, file)} 用 ${method} 调 ${apiPath}，后端只接受 ${[...allowed].join('/')}`);
      }
    }
  }

  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

/* ============================================================
   合规红线
   ============================================================ */

test('小程序：界面里不出现任何交易或金额用语', () => {
  const FORBIDDEN = ['价格', '金额', '下单', '订单', '购买', '购物车', '结算',
                     '库存', '发货', '收货', '支付', '售价'];
  const problems = [];

  for (const file of allSourceFiles()) {
    const rel = path.relative(MP, file).replace(/\\/g, '/');
    if (rel === 'project.config.json' || rel === 'app.json') continue;  // 配置里的 desc 不算界面
    const src = read(file);
    for (const w of FORBIDDEN) {
      if (src.includes(w)) problems.push(`${rel} 出现禁用词「${w}」`);
    }
    const m = src.match(/¥|\d+\s*元/);
    if (m) problems.push(`${rel} 出现金额：${JSON.stringify(m[0])}`);
  }

  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

test('小程序：关键页面都带「仅登记名额、不收费」的声明', () => {
  for (const f of ['pages/home/index.wxml', 'pages/profile/index.wxml',
                   'packageBazaar/pages/items/index.wxml',
                   'packageBazaar/pages/detail/index.wxml']) {
    const src = read(path.join(MP, f));
    assert.match(src, /(只|仅)(登记|锁定)[^。]{0,8}名额/, `${f} 缺少合规声明`);
  }
});

/* ============================================================
   结构合理性
   ============================================================ */

test('小程序：图鉴数据放主包（tabBar 页面要用，主包拿不到分包的文件）', () => {
  assert.ok(exists(path.join(MP, 'data', 'cats.js')), 'data/cats.js 必须在主包');

  const catsPage = read(path.join(MP, 'pages', 'cats', 'index.js'));
  assert.match(catsPage, /from '\.\.\/\.\.\/data\/cats\.js'/,
    '主包的图鉴列表页应当直接从主包拿数据');
});

test('小程序：分包目录与 app.json 声明一致', () => {
  const cfg = appJson();
  for (const sp of cfg.subPackages) {
    assert.ok(exists(path.join(MP, sp.root)), `分包目录 ${sp.root} 不存在`);
    assert.match(sp.root, /^package[A-Z]/,
      `分包目录 ${sp.root} 命名不规范，建议 packageXxx`);
  }
});

test('小程序：主包体积还很小（上限 2MB，留足余量）', () => {
  const cfg = appJson();
  const subRoots = cfg.subPackages.map((s) => s.root);

  let mainBytes = 0;
  for (const f of walk(MP)) {
    const rel = path.relative(MP, f).replace(/\\/g, '/');
    if (subRoots.some((r) => rel.startsWith(r + '/'))) continue;
    mainBytes += fs.statSync(f).size;
  }

  const kb = mainBytes / 1024;
  assert.ok(kb < 512, `主包已经有 ${kb.toFixed(0)} KB，骨架阶段不该这么大`);
});

test('小程序：代码里不含任何硬编码的密钥', () => {
  const problems = [];
  for (const file of jsFiles()) {
    const src = read(file);
    // AppSecret 只能待在后端。出现在小程序里就等于公开了。
    if (/WX_SECRET\s*[:=]\s*['"][^'"]{8,}/.test(src)) problems.push(path.relative(MP, file));
    if (/SESSION_SECRET\s*[:=]\s*['"][^'"]{8,}/.test(src)) problems.push(path.relative(MP, file));
  }
  assert.deepEqual(problems, [], '小程序里不能出现任何密钥：\n' + problems.join('\n'));
});

test('小程序：所有 JS 文件语法正确（本地跑不了真机，至少保证能编译）', async () => {
  // 取巧的办法：动态 import 每个文件。
  //   抛 SyntaxError   → 真的有语法错
  //   抛 ReferenceError → 语法没问题，只是 Page/App/wx 这些全局在 Node 里不存在
  // 两者必须分开看，否则「跑不起来」什么都说明不了。
  const problems = [];

  for (const file of jsFiles()) {
    try {
      await import(new URL('file://' + file.replace(/\\/g, '/')).href);
    } catch (e) {
      const isSyntax = (e && e.constructor && e.constructor.name === 'SyntaxError')
        || /SyntaxError/.test(String(e));
      if (isSyntax) {
        problems.push(`${path.relative(MP, file)}: ${e.message}`);
      }
      // 其余一律当作「缺小程序全局」，不算失败
    }
  }

  assert.deepEqual(problems, [], '存在语法错误：\n' + problems.join('\n'));
});

test('小程序：生产环境地址必须是 HTTPS 且不是占位符以外的假地址', () => {
  const cfg = read(path.join(MP, 'config.js'));
  const m = /PROD_BASE\s*=\s*'([^']+)'/.exec(cfg);
  assert.ok(m, '找不到 PROD_BASE');

  const url = m[1];
  assert.match(url, /^https:\/\//,
    'Prod 必须是 HTTPS —— 小程序的 request 合法域名不接受 http');
  assert.doesNotMatch(url, /127\.0\.0\.1|localhost/,
    '生产地址不能是本机地址，正式版发不出请求');
  assert.doesNotMatch(url, /^https:\/\/\d+\.\d+\.\d+\.\d+/,
    '不能直接用 IP —— 小程序不支持 IP，必须用已备案的域名');
});

test('小程序：请求地址按「跑在哪儿」选，不是按 envVersion 选', () => {
  // 开发者工具（模拟器）→ 本机后端
  assert.equal(pickBaseUrl({ platform: 'devtools', envVersion: 'develop' }),
    'http://127.0.0.1:3000', '开发者工具里应该连本机后端');

  // 真机：预览的 envVersion 是 'develop'，体验版是 'trial'，都**不是** release。
  // 这里曾经写成 `IS_DEV ? DEV_BASE : PROD_BASE`，于是真机也拿到 127.0.0.1 ——
  // 那是手机自己，请求全部失败，现象看起来是「后端挂了」。这条断言防止改回去。
  for (const platform of ['ios', 'android', 'windows', 'mac']) {
    for (const envVersion of ['develop', 'trial', 'release']) {
      assert.equal(pickBaseUrl({ platform, envVersion }), API_BASE,
        `真机 ${platform} / ${envVersion} 必须连线上地址，不能是本机回环`);
    }
  }

  // 读不到环境（例如被 Node import）时保守选线上，不要意外连本机
  assert.equal(pickBaseUrl({}), API_BASE);
  assert.equal(pickBaseUrl(), API_BASE);
});

test('小程序：开发地址与生产地址各自形态正确，不能互相串', () => {
  assert.match(API_BASE, /^https:\/\//, '生产地址必须是 HTTPS 域名');
  assert.match(pickBaseUrl({ platform: 'devtools' }), /^http:\/\/127\.0\.0\.1:\d+$/,
    '开发地址应当是本机 http，真机连不上是预期的');
  assert.notEqual(pickBaseUrl({ platform: 'devtools' }), API_BASE);
});

test('小程序：「我的」页必须拉一次最新角色，否则提权后入口永远不出现', () => {
  // 角色的真正来源是服务端，客户端缓存里那份会过期。
  // refreshUser() 曾经定义了却没人调用 —— 结果管理员用脚本提权之后，
  // 管理端和核销台入口一直不显示，而在开发者工具里清缓存会换成一个新身份。
  const src = fs.readFileSync(path.join(MP, 'pages', 'profile', 'index.js'), 'utf8');
  assert.match(src, /session\.refreshUser\(\)/,
    '「我的」页必须调用 session.refreshUser()，否则改过的角色到不了界面');
  assert.match(src, /onShow\s*\(\)/, '应当在 onShow 里拉，用户每次进来都会刷新');
});

test('小程序：管理端计划还在，且没丢掉合规约束和本期范围', () => {
  // 计划文档容易在后续编辑里被清空或改味，这里把它钉住几处关键决定。
  const plan = read(path.join(ROOT, 'docs', 'admin-plan.md'));

  // 方向：做在小程序里（理由也一并留着，否则以后有人会重新纠结要不要做网页端）
  assert.match(plan, /管理端做在小程序里/, '必须保留「做在小程序里」这个已定方向');

  // 本期五项
  for (const w of ['看预定名单', '改物品名额', '撤销误核销', '取消别人的预定', '取货码二维码']) {
    assert.ok(plan.includes(w), `管理端计划里少了本期范围「${w}」`);
  }

  // 明确不做的两项也要留着，免得又有人提
  assert.match(plan, /分时段取货/, '要保留「本期不做分时段取货」这个决定');
  assert.match(plan, /摊位分权/, '要保留「本期不做摊位分权」这个决定');

  // 唯一要动后端的那个，必须写明复用已有取消逻辑，不能另写更新语句
  assert.match(plan, /cancelReservation/, '取消别人的预定必须复用 cancelReservation 的名额回滚逻辑');

  // ★ 合规：管理端不改变主体性质，但文案守同一套口径
  assert.match(plan, /不改变小程序的主体性质/, '要写明有管理端不等于组织运营');
});

test('小程序：界面角色判定必须和服务端 roles.mjs 一致', () => {
  // 这两个列表是小程序里手写的服务端角色表副本 —— 曾经漏了 deputy，
  // 于是副主任管理员在界面上被当成学生、管理入口不显示。
  // 这里用服务端的谓词反推应有列表，而不是再抄一遍。
  const expectedRedeem = ROLES.filter(canRedeem).sort();
  const expectedManage = ROLES.filter(canManage).sort();
  const expectedAdminister = ROLES.filter(canAdminister).sort();

  assert.deepEqual([...ROLES_CAN_REDEEM].sort(), expectedRedeem,
    `能核销的角色应当是 [${expectedRedeem}]，界面写的是 [${ROLES_CAN_REDEEM}]`);
  assert.deepEqual([...ROLES_CAN_MANAGE].sort(), expectedManage,
    `能管理的角色应当是 [${expectedManage}]，界面写的是 [${ROLES_CAN_MANAGE}]`);
  assert.deepEqual([...ROLES_CAN_ADMINISTER].sort(), expectedAdminister,
    `能管「影响全场」那类事的角色应当是 [${expectedAdminister}]，`
    + `界面写的是 [${ROLES_CAN_ADMINISTER}]`);

  // 管理门槛必须严格高于核销门槛，否则会出现「能进管理端却进不了核销台」
  for (const r of ROLES_CAN_MANAGE) {
    assert.ok(ROLES_CAN_REDEEM.includes(r), `能管理的角色 ${r} 必须也能核销`);
  }
  for (const r of ROLES_CAN_ADMINISTER) {
    assert.ok(ROLES_CAN_MANAGE.includes(r), `能管活动的角色 ${r} 必须也能进管理端`);
  }

  // 显示名要覆盖全部角色 —— 漏一个就会在界面上显示成默认的「学生」
  assert.deepEqual(Object.keys(ROLE_LABEL).sort(), [...ROLES].sort(),
    `角色显示名必须覆盖服务端全部角色 [${ROLES}]，当前只有 [${Object.keys(ROLE_LABEL)}]`);
});

/* ============================================================
   管理端取消原因（选项 + 其他手填）
   ============================================================ */

test('取消原因：预设标签必须落在后端允许的长度内', () => {
  // 后端 asReason 要求 2–60 字。标签超了的话，管理员选完提交才被拒 ——
  // 报错出现在提交那一刻而不是加标签那一刻，很难查。这里提前拦住。
  assert.ok(REASONS.length >= 3, '原因太少，等于没做成选项');

  for (const r of REASONS) {
    assert.ok(r.label.length >= REASON_MIN && r.label.length <= REASON_MAX,
      `「${r.label}」长度 ${r.label.length} 不在 ${REASON_MIN}–${REASON_MAX} 内`);
    assert.ok(r.key && r.key !== OTHER_KEY, `key「${r.key}」不能和 OTHER_KEY 撞`);
  }

  const keys = REASONS.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length, 'key 不能重复');
});

test('取消原因：选中预设原因就原样发出，不掺手填文字', () => {
  // 从「其他」切回预设项时输入框里可能还留着字，不能被带进去
  for (const r of REASONS) {
    const v = composeReason(r.key, '这段残留文字应当被忽略');
    assert.equal(v.ok, true);
    assert.equal(v.reason, r.label);
  }
});

test('取消原因：「其他」拼上前缀并去掉首尾空白', () => {
  const v = composeReason(OTHER_KEY, '  临时有事来不了  ');
  assert.equal(v.ok, true);
  assert.equal(v.reason, '其他：临时有事来不了');
  assert.ok(v.reason.length <= REASON_MAX, '拼完不能超后端的长度上限');
});

test('取消原因：「其他」空着要拒；长度按「含前缀」算', () => {
  for (const t of ['', '   ', null, undefined]) {
    assert.equal(composeReason(OTHER_KEY, t).ok, false, `「${t}」应当被拒`);
  }

  // 边界：前缀也占长度，所以手填上限是 REASON_MAX 减前缀长度
  const max = REASON_MAX - '其他：'.length;
  assert.equal(composeReason(OTHER_KEY, 'x'.repeat(max)).ok, true, `刚好 ${max} 字应当通过`);
  assert.equal(composeReason(OTHER_KEY, 'x'.repeat(max + 1)).ok, false,
    `超过 ${max} 字应当被拒（否则拼上前缀就超后端上限了）`);
});

test('取消原因：没选、或选了不存在的 key 都要拒', () => {
  for (const key of ['', null, undefined, 'ghost']) {
    assert.equal(composeReason(key).ok, false, `key「${key}」应当被拒`);
  }
});

/* ============================================================
   ★ 样式雷区：calc() 里不能出现 rpx
   ============================================================ */

/**
 * 取出所有 `calc(...)` 的**完整**参数，包括 env(...) 这种嵌套括号。
 * 直接上正则 `calc\(([^()]*)\)` 会因为嵌套而漏掉它们。
 */
function calcArgs(src) {
  const out = [];
  let i = src.indexOf('calc(');
  while (i !== -1) {
    let depth = 0;
    let j = i + 4;                       // 指向 calc 后面那个 '('
    for (; j < src.length; j++) {
      if (src[j] === '(') depth += 1;
      else if (src[j] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(i + 5, j));
    i = src.indexOf('calc(', j);
  }
  return out;
}

/** 去掉 /* … *\/ 注释。反面教材写在注释里，不先删掉会把文档自己测红。 */
const stripCssComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');

/** 一段 wxss 里所有「calc() 且参数含 rpx」的地方。命中即为真机上的失效声明。 */
function rpxInCalc(src) {
  return calcArgs(stripCssComments(src)).filter((arg) => /rpx/.test(arg));
}

test('样式雷区自测：能真的从 calc() 里取出参数', () => {
  // 先证明这个扫描器本身有效，否则下面那条「全绿」什么都说明不了
  assert.deepEqual(calcArgs('width: calc(50% - 12rpx);'), ['50% - 12rpx']);
  assert.deepEqual(calcArgs('padding: calc(20px + env(safe-area-inset-bottom));'),
    ['20px + env(safe-area-inset-bottom)'], 'env() 这种嵌套括号不能被截断');
  assert.deepEqual(calcArgs('a: calc(1px + 2px); b: calc(3px);'), ['1px + 2px', '3px']);
  assert.deepEqual(calcArgs('width: 100rpx;'), [], '没有 calc 就不该有结果');
});

test('样式雷区自测：这套判定能真的抓到 rpx-in-calc，也不误报', () => {
  // ★ 这条才是关键：只测「扫描器能取参数」是不够的，
  //   得证明「判定本身抓得到真问题、也不会把正常写法当成问题」。
  assert.deepEqual(rpxInCalc('width: calc(50% - 12rpx);'), ['50% - 12rpx'],
    'rpx 在 calc 里必须被抓到 —— 这正是猫猫图鉴一行只显示一只的原因');
  assert.deepEqual(rpxInCalc('.a { width: 100rpx; height: 50%; }'), [],
    '不在 calc 里的 rpx 是完全正常的写法，不能误报');
  assert.deepEqual(rpxInCalc('padding-bottom: calc(16px + env(safe-area-inset-bottom));'), [],
    'calc 里用 px + env() 是安全的写法，不能误报');
  // 同一行里既有 calc 又有普通 rpx：只该报 calc 那部分
  assert.deepEqual(rpxInCalc('padding: 20rpx 32rpx calc(20px + env(a));'), [],
    'calc 外面的 rpx 不该被算进去（这就是不能按整行判断的原因）');
  assert.deepEqual(rpxInCalc('padding: 20rpx 32rpx calc(20rpx + env(a));'), ['20rpx + env(a)']);
  // 注释里的反面教材不算数
  assert.deepEqual(rpxInCalc('/* 别写 calc(50% - 12rpx) */\n.a { width: 48%; }'), []);
});

test('样式：★ calc() 里不能出现 rpx（真机上算不出来）', () => {
  // 症状：猫猫图鉴和物品列表「一行只显示一个，右边空出一大片」。
  // 原因：开发者工具按模拟机宽度在**编译期**把 rpx 换成 px，所以模拟器正常；
  //      真机的屏幕宽度只有运行时才知道，那次替换进不到 calc 内部，
  //      浏览器不认识 rpx → 整条 width 判为非法值丢掉 → 卡片按内容定宽。
  // 这份守卫是**类级**的：以后再有人写 calc(...rpx...) 会立刻红，
  // 而不是等到真机上才发现。
  const problems = [];

  for (const file of allSourceFiles().filter((f) => f.endsWith('.wxss'))) {
    for (const arg of rpxInCalc(read(file))) {
      problems.push(`${path.relative(MP, file).replace(/\\/g, '/')}: calc(${arg})`);
    }
  }

  assert.deepEqual(problems, [],
    'calc() 里出现 rpx，真机上整条声明会失效。'
    + '宽度改用百分比（如 48% + justify-content: space-between），'
    + '内边距改用 px：\n' + problems.join('\n'));
});

test('样式：两列卡片不能用 calc 定宽，也不能只靠 flex 的 gap', () => {
  // flex 的 gap 要 iOS 14.1 / Chrome 84 以上，旧 iOS 上会失效。
  // 因此这两处两列布局用「48% 定宽 + space-between + margin-bottom」，
  // 三样都是任何 WebView 都支持的老写法。
  for (const f of ['pages/cats/index.wxss', 'packageBazaar/pages/items/index.wxss']) {
    // 同样要先去掉注释：那里面正写着「不要用 calc(50% - 12rpx)」这个反面教材
    const src = read(path.join(MP, f)).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/calc\(/.test(src), `${f} 里不该再用 calc 定宽`);
    assert.match(src, /justify-content:\s*space-between/, `${f} 缺少 space-between`);
    assert.match(src, /width:\s*48%/, `${f} 的卡片宽度应当是 48%`);
    assert.match(src, /margin-bottom:\s*24rpx/, `${f} 的行距应当用 margin-bottom`);
  }
});

/* ============================================================
   ★ 事实性错误守卫：<image> 不受服务器域名白名单限制
   ============================================================ */

/**
 * 找出文档里「要求读者去配 downloadFile 白名单」的句子。
 *
 * 要区分「要配」和「不要配」—— 纠正这个说法的文档本身必然会提到它，
 * 如果把提到就算违规，就没法把正确的结论写下来了。
 * 判据：这 24 个字里有没有否定词。
 */
function claimsDownloadFileWhitelistNeeded(src) {
  const hits = [];
  const re = /downloadFile\s*合法域名/g;
  let m = re.exec(src);
  while (m !== null) {
    const before = src.slice(Math.max(0, m.index - 24), m.index);
    if (!/[不别没]|无需|不用/.test(before)) hits.push(`${before}${m[0]}`);
    m = re.exec(src);
  }
  return hits;
}

test('文档守卫自测：抓得住「要配」，也放得过「不要配」', () => {
  assert.equal(claimsDownloadFileWhitelistNeeded('去后台把 downloadFile 合法域名加上').length, 1,
    '要求读者去配 —— 必须抓到');
  assert.equal(claimsDownloadFileWhitelistNeeded('不要为了图片去配 downloadFile 合法域名').length, 0,
    '这是纠正文，不能误报（否则正确结论写不下来）');
  assert.equal(claimsDownloadFileWhitelistNeeded('无需配置 downloadFile 合法域名').length, 0);
  assert.equal(claimsDownloadFileWhitelistNeeded('照片走 image 组件，不受域名白名单限制').length, 0,
    '压根没提到，当然不算');
});

test('文档：不能把「配 downloadFile 合法域名」说成看图片的前提', () => {
  // 我在这里犯过一次错：查到一个博客说「微信加载网络图片必须配 downloadFile
  // 合法域名」，就照着写进了手册和 FAQ。这是错的 ——
  //   · 白名单管的是 wx.request / wx.uploadFile / wx.downloadFile / wx.connectSocket
  //     这几个 **API**，`<image>` 是个**组件**；
  //   · 官方 image 组件文档里根本没有白名单这一项；
  //   · 仓库里 data/cats.js 和 miniprogram-build.test.mjs 早就写着「不受限制」；
  //   · 那篇博客自己的数据就自相矛盾：失败的那张是 http://，成功的是 https://，
  //     真正的原因是「微信不接受 http 图片」，不是白名单。
  // 危害在于**误导排查方向**：真机上图片不显示时，人会跑去后台加域名，白折腾。
  const problems = [];
  for (const file of walk(ROOT, (f) => f.endsWith('.md'))) {
    for (const hit of claimsDownloadFileWhitelistNeeded(read(file))) {
      problems.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}: …${hit}`);
    }
  }

  assert.deepEqual(problems, [],
    '这些文档把 <image> 说成受服务器域名白名单限制了。'
    + '<image> 是组件，不受白名单限制；真机不显示要先查 HTTPS 和服务器连通性：\n'
    + problems.join('\n'));
});

test('照片：每张图都要有失败回退，列表图还要懒加载', () => {
  // 两条都是真机上才暴露的问题：
  //   · 没有 binderror → 加载失败时那一格**永远空着**，比 emoji 还难看，
  //     而且完全看不出是加载失败；
  //   · 没有 lazy-load → 首屏把列表里**所有**照片一起拉。几十张图同时下载，
  //     在真机调试那种绕经电脑的通道上会直接把页面拖住。
  const listSites = [
    'packageBazaar/pages/items/index.wxml',
    'packageBazaar/pages/my-reservations/index.wxml',
    'packageAdmin/pages/items/index.wxml',
  ];
  const allSites = [...listSites, 'packageBazaar/pages/detail/index.wxml'];

  for (const f of allSites) {
    const src = read(path.join(MP, f));
    const tags = src.match(/<image[\s\S]*?\/>/g) || [];
    assert.ok(tags.length >= 1, `${f} 里找不到 <image>，正则可能失效了`);

    for (const tag of tags) {
      assert.match(tag, /binderror="onImageError"/,
        `${f} 有一张图没接 binderror —— 加载失败时那一格会永远空着`);
      assert.match(tag, /mode="aspectFill"/, `${f} 有一张图缺 aspectFill`);
      assert.match(tag, /wx:if="\{\{item\.imageUrl[^"]*\}\}"/,
        `${f} 的 wx:if 要带上「失败过就别再显示」的判断`);
    }

    const js = read(path.join(MP, f.replace('.wxml', '.js')));
    assert.match(js, /onImageError/, `${f} 对应的页面没有实现 onImageError`);
  }

  for (const f of listSites) {
    for (const tag of read(path.join(MP, f)).match(/<image[\s\S]*?\/>/g)) {
      assert.match(tag, /lazy-load/,
        `${f} 的列表图缺 lazy-load —— 首屏会同时下载几十张照片`);
    }
  }
});

/* ============================================================
   ★ 管理端活动与摊位
   ============================================================ */

test('小程序：页面里不许手写角色名（判定要收在 session.js 里）', () => {
  // reservations 页原来自已写了一份 `role === 'admin' || role === 'owner'` ——
  // 服务端改规则时那份不会跟着动，而且没有测试盯着。
  // 现在判定统一收在 session.js，由上面的漂移测试比对。
  const problems = [];
  for (const file of jsFiles()) {
    const rel = path.relative(MP, file).replace(/\\/g, '/');
    // session.js 是那些列表的定义处，当然可以出现角色名
    if (rel === 'services/session.js') continue;

    // 只抓「和角色字符串做相等比较」的写法；文案里出现「管理员」不算
    for (const m of read(file).matchAll(
      /['"](student|volunteer|deputy|admin|owner)['"]\s*(?:===|!==|==|!=)/g)) {
      problems.push(`${rel}: ${m[0]}`);
    }
  }

  assert.deepEqual(problems, [],
    '这些地方在手写角色判定 —— 改用 session.js 的 isStaff / isManager / isSeniorManager：\n'
    + problems.join('\n'));
});

test('活动页：结构齐全，入口进得去，门槛分两级', () => {
  const cfg = appJson();
  const admin = cfg.subPackages.find((s) => s.root === 'packageAdmin');
  assert.ok(admin.pages.includes('pages/event/index'), '活动页要注册在 packageAdmin 里');

  for (const f of ['index.js', 'index.wxml', 'index.wxss', 'index.json']) {
    assert.ok(exists(path.join(MP, 'packageAdmin/pages/event', f)), `缺 ${f}`);
  }

  // 入口：物品名额那个入口旁边
  const wxml = read(path.join(MP, 'pages/profile/index.wxml'));
  assert.match(wxml, /bindtap="goAdminEvent"/, '「我的」页要有入口，否则这页进不去');
  assert.match(wxml, /活动与摊位/);

  const js = read(path.join(MP, 'pages/profile/index.js'));
  const m = js.match(/goAdminEvent\(\)[\s\S]{0,220}?navigateTo\(\{\s*url:\s*['"]([^'"]+)['"]/);
  assert.ok(m, '找不到 goAdminEvent 的跳转');
  const target = m[1].replace(/^\//, '').replace(/\/index$/, '');
  const all = [
    ...cfg.pages,
    ...cfg.subPackages.flatMap((sp) => sp.pages.map((p) => `${sp.root}/${p}`)),
  ].map((p) => p.replace(/\/index$/, ''));
  assert.ok(all.includes(target), `跳到了不存在的页面：${m[1]}`);

  // ★ 同一页里两种门槛：摊位 deputy+、活动 admin+
  const page = read(path.join(MP, 'packageAdmin/pages/event/index.js'));
  assert.match(page, /session\.isManager\(\)/, '摊位部分用 isManager');
  assert.match(page, /session\.isSeniorManager\(\)/, '活动部分用 isSeniorManager');
  const pageWxml = read(path.join(MP, 'packageAdmin/pages/event/index.wxml'));
  assert.match(pageWxml, /wx:if="\{\{canAdminister\}\}"/, '建活动那块要按 canAdminister 显示');
  assert.match(pageWxml, /wx:if="\{\{canManage\}\}"/, '建摊位那块要按 canManage 显示');
});

test('活动页：时间不自己算，拼字符串交给服务端', () => {
  const page = read(path.join(MP, 'packageAdmin/pages/event/index.js'));

  // ★ 客户端 new Date(...) 是按**手机时区**解释的，看着对，存进库就未必。
  //   所以用 date / time 两个 picker 拿字符串，拼起来发过去。
  assert.match(page, /mode="date"|buildTime/, '要用 picker 拿日期');
  assert.match(page, /`\$\{date\} \$\{time\}`/, '要拼成 "YYYY-MM-DD HH:MM" 交给服务端解析');

  // 页面上不许拿 Date 去算要存的时间戳
  assert.ok(!/Date\.now\(\)/.test(page), '不要自己算时间戳');
  assert.ok(!/getTime\(\)/.test(page), '不要自己算时间戳');

  const wxml = read(path.join(MP, 'packageAdmin/pages/event/index.wxml'));
  assert.match(wxml, /<picker mode="date"/, '日期用日期选择器');
  assert.match(wxml, /<picker mode="time"/, '时间用时间选择器');
});

test('活动页：★ 建新的在售活动前要先问「把旧的结束掉吗」', () => {
  // 两个在售并存的话，首页只显示最新的那个、管理端却看着有两个 ——
  // 排查起来很费劲。所以宁可多问一句，也别静默地让两个并存。
  const page = read(path.join(MP, 'packageAdmin/pages/event/index.js'));

  const submit = /async submitEvent\([\s\S]*?\n  \},/.exec(page);
  assert.ok(submit, '找不到 submitEvent');
  assert.match(submit[0], /showModal/, '建在售活动前要弹确认');
  assert.match(submit[0], /endPrevious/, '确认之后要带上 endPrevious，让服务端把它结束掉');
  // 确认框里要说清后果
  assert.match(submit[0], /结束掉|看不到/, '要告诉用户旧的会被结束、学生看不到了');
});

test('活动页：结束活动要留日志、要能收尾（以前只能改数据库）', () => {
  const page = read(path.join(MP, 'packageAdmin/pages/event/index.js'));
  assert.match(page, /api\/admin\/event\/status/, '要有改状态的调用');
  assert.match(page, /toggleStatus/, '要有开始/结束的入口');

  const wxml = read(path.join(MP, 'packageAdmin/pages/event/index.wxml'));
  assert.match(wxml, /bindtap="toggleStatus"/);
  assert.match(wxml, /{{item\.action}}/, '按钮文案要跟着状态走（开始 / 结束）');
});

/* ============================================================
   管理端新建物品
   ============================================================ */

const STALLS = [
  { id: 'st_1', name: '一号摊位 · 手作烘焙', loc: '图书馆前广场东侧' },
  { id: 'st_2', name: '二号摊位 · 闲置好物' },
];

test('新建物品：界面的字数/名额上限必须和服务端一模一样', () => {
  // 这两份是小程序和服务端各写一遍的副本（小程序 import 不了服务端代码）。
  // 界面放宽 → 用户填到点提交才被拒，报错还说不清是哪一项。
  assert.equal(itemForm.NAME_MAX, ITEM_NAME_MAX, '物品名上限两边不一致');
  assert.equal(itemForm.DESC_MAX, ITEM_DESC_MAX, '简介上限两边不一致');
  assert.equal(itemForm.QUOTA_MAX, ITEM_QUOTA_MAX, '名额上限两边不一致');
  assert.equal(itemForm.EMOJI_MAX, ITEM_EMOJI_MAX, '图标上限两边不一致');
});

test('新建物品：可选底色要和服务端一致，而且 app.wxss 里真有那些类', () => {
  assert.deepEqual(itemForm.TINTS.map((t) => t.key), ITEM_TINTS,
    '配色列表和服务端对不上 —— 发过去会被 400，或者渲染成一个没有底色的白块');

  const wxss = read(path.join(MP, 'app.wxss'));
  for (const key of ITEM_TINTS) {
    assert.match(wxss, new RegExp(`\\.${key}\\s*\\{`), `app.wxss 里没有 .${key} 这个类`);
  }

  // 反向也要对：app.wxss 里的 .t-* 不能多出来 —— 多出来的都是没人用的死样式
  const inWxss = [...wxss.matchAll(/^\.(t-[a-z]+)\s*\{/gm)].map((m) => m[1]).sort();
  assert.deepEqual(inWxss, [...ITEM_TINTS].sort(),
    `app.wxss 里的底色类 [${inWxss}] 和服务端的 ITEM_TINTS 对不上`);
});

test('新建物品：本地的表单校验要拦在提交之前', () => {
  const good = itemForm.buildCreateBody({
    name: '  手作黄油曲奇  ',
    description: '  独立包装，一盒六块  ',
    emoji: '🍪',
    tint: 't-blue',
    totalQuota: ' 12 ',
    stallIndex: 1,
  }, STALLS);

  assert.equal(good.ok, true, JSON.stringify(good));
  assert.deepEqual(good.body, {
    name: '手作黄油曲奇',            // 首尾空白要去掉
    description: '独立包装，一盒六块',
    emoji: '🍪',
    tint: 't-blue',
    image: null,                    // 没配照片就是 null，服务端认这个值
    totalQuota: 12,                 // 输入框给的是字符串，要转成数字
    stallId: 'st_1',
  });

  const bad = [
    [{ totalQuota: 1 }, /名称/],
    [{ name: '   ', totalQuota: 1 }, /名称/],
    [{ name: 'x'.repeat(ITEM_NAME_MAX + 1), totalQuota: 1 }, /名称/],
    [{ name: 'x' }, /正整数/],
    [{ name: 'x', totalQuota: '' }, /正整数/],
    [{ name: 'x', totalQuota: 'abc' }, /正整数/],
    [{ name: 'x', totalQuota: 0 }, /正整数/],
    [{ name: 'x', totalQuota: 1.5 }, /正整数/],
    [{ name: 'x', totalQuota: ITEM_QUOTA_MAX + 1 }, /最多/],
    [{ name: 'x', totalQuota: 1, emoji: 'x'.repeat(ITEM_EMOJI_MAX + 1) }, /图标/],
    [{ name: 'x', totalQuota: 1, description: 'x'.repeat(ITEM_DESC_MAX + 1) }, /简介/],
  ];
  for (const [form, re] of bad) {
    const r = itemForm.buildCreateBody(form, STALLS);
    assert.equal(r.ok, false, `${JSON.stringify(form)} 应当被拦下`);
    assert.match(r.error, re, `「${r.error}」没指出是哪一项不对`);
  }
});

test('新建物品：一个 emoji 不该被当成两个字拒掉', () => {
  // '🍪'.length 是 2（代理对）。拿 length 当上限的话，一个字都填不了。
  const r = itemForm.buildCreateBody({ name: '曲奇', totalQuota: 1, emoji: '🍪' }, STALLS);
  assert.equal(r.ok, true, '按码点数算的话，一个 emoji 只占一个字');
  assert.equal(r.body.emoji, '🍪');

  // 但两个字就是两个字
  assert.equal(itemForm.buildCreateBody(
    { name: '曲奇', totalQuota: 1, emoji: '曲奇' }, STALLS).ok, true);
  assert.equal(itemForm.buildCreateBody(
    { name: '曲奇', totalQuota: 1, emoji: '曲奇饼' }, STALLS).ok, false);
});

test('新建物品：摊位选择器的下标换算', () => {
  // 下标 0 固定是「不指定摊位」，所以选中项要减 1 才是 stalls 的下标
  assert.deepEqual(itemForm.stallOptions(STALLS), [
    itemForm.NO_STALL_TEXT,
    '一号摊位 · 手作烘焙（图书馆前广场东侧）',
    '二号摊位 · 闲置好物',
  ]);

  assert.equal(itemForm.stallIdAt(STALLS, 0), null, '0 是不指定摊位');
  assert.equal(itemForm.stallIdAt(STALLS, '1'), 'st_1');
  assert.equal(itemForm.stallIdAt(STALLS, 2), 'st_2');
  assert.equal(itemForm.stallIdAt(STALLS, 99), null, '越界不能崩');
  assert.equal(itemForm.stallIdAt([], 1), null, '一个摊位都没有时也不能崩');

  // 没选摊位时 stallId 是 null —— 服务端认这个值，不会当成非法 id
  const r = itemForm.buildCreateBody({ name: '曲奇', totalQuota: 1, stallIndex: 0 }, STALLS);
  assert.equal(r.ok, true);
  assert.equal(r.body.stallId, null);
});

test('新建物品：页面注册了，而且从物品名额页进得去', () => {
  const cfg = appJson();
  const admin = cfg.subPackages.find((s) => s.root === 'packageAdmin');
  assert.ok(admin, 'packageAdmin 分包不见了');
  assert.ok(admin.pages.includes('pages/item-new/index'),
    '新建物品页没注册进 app.json，开发者工具会直接报错');

  for (const f of ['index.js', 'index.wxml', 'index.wxss', 'index.json']) {
    assert.ok(exists(path.join(MP, 'packageAdmin/pages/item-new', f)), `缺 ${f}`);
  }

  // 光有页面没用，得有人到得了 —— 入口必须在物品名额页上
  const itemsWxml = read(path.join(MP, 'packageAdmin/pages/items/index.wxml'));
  assert.match(itemsWxml, /bindtap="goNew"/, '物品名额页上找不到新建入口');
  assert.match(itemsWxml, /新建物品/);

  // 入口跳的地址必须真的存在（写错了只在真机上点一下才会发现）
  const itemsJs = read(path.join(MP, 'packageAdmin/pages/items/index.js'));
  const m = itemsJs.match(/navigateTo\(\{\s*url:\s*['"]([^'"]+)['"]/);
  assert.ok(m, '物品名额页里找不到 navigateTo');

  const target = m[1].replace(/^\//, '').replace(/\/index$/, '');
  const all = [
    ...cfg.pages,
    ...cfg.subPackages.flatMap((sp) => sp.pages.map((p) => `${sp.root}/${p}`)),
  ].map((p) => p.replace(/\/index$/, ''));

  assert.ok(all.includes(target), `跳到了不存在的页面：${m[1]}\n已声明：${all.join(', ')}`);
});

test('新建物品：提交时打的是服务端真正有的那个接口', () => {
  const js = read(path.join(MP, 'packageAdmin/pages/item-new/index.js'));
  assert.match(js, /api\.post\(\s*'\/api\/admin\/item\/create'/, '接口路径写错了');

  // ★ 「新建」和「改」是两个不同的接口，别把 create 混进改物品那条路上
  assert.ok(!/api\.post\(\s*'\/api\/admin\/item'/.test(js),
    '新建物品不该复用改物品的接口 —— 那个要求带 itemId');

  // 权限判定不能只写在界面上，但界面上也必须有（不然学生点进去是一片空白表单）
  assert.match(js, /session\.isManager\(\)/, '页面要先自己判一次权限');
});

test('登记：提交按钮的每条出口都要给用户一句话', () => {
  // 曾经的 bug：账号已经存在时（退出登录后又想登记，或换了调试会话、
  // 本地缓存被清了）走的是 `if (r.registered) { this.refresh(); return; }` ——
  // 静默返回，用户点「完成登记」屏幕毫无反应，看起来就是「昵称提交不了」。
  const js = read(path.join(MP, 'pages', 'profile', 'index.js'));
  const body = js.slice(js.indexOf('async submitRegister'));

  // 每个 return 之前都得有提示（校验不通过、登记成功、已经登记过）
  const returns = body.split('\n').filter((l) => /\breturn\b/.test(l));
  assert.ok(returns.length >= 3, '提交逻辑里应当有若干个出口');

  // 具体钉住那条曾经静默的分支
  const regBranch = /if \(r\.registered\)\s*\{([\s\S]{0,220}?)\}/.exec(body);
  assert.ok(regBranch, '找不到「已经登记过」那个分支');
  assert.match(regBranch[1], /showToast|showModal/,
    '「已经登记过了」必须说出来 —— 静默返回会让用户以为按钮坏了');
  assert.ok(!/^\s*this\.refresh\(\);\s*return;/m.test(regBranch[1]),
    '这一支不能是「refresh 完就 return」');
});

test('登录：★ wx.login 不响应时要超时，不能永远挂着（症状是「点了没反应」）', async () => {
  const platform = await import('../miniprogram/services/platform.js');
  const session = await import('../miniprogram/services/session.js');

  // 模拟「wx.login 的回调永远不来」。真机上真的会这样（微信会话状态坏了、
  // 真机调试通道卡住），而原来这里会一直 await 下去 —— 界面停在「提交中…」，
  // 按钮一直禁用，没有报错也没有重试入口。用户只会说「点了没反应」。
  platform.setPlatform({ login: () => new Promise(() => {}) });
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => session.login({ timeoutMs: 40 }),
      (e) => e && e.code === 'login_timeout' && /退出小程序/.test(e.message),
      '要超时并给出「照着做就行」的说法',
    );
    assert.ok(Date.now() - t0 < 3000, '要按注入的超时返回，不能真等 15 秒');
  } finally {
    platform.resetPlatform(platform.originalPlatform);
    session.resetCache();
  }
});

test('登录：wx.login 正常时不该被超时误伤', async () => {
  const platform = await import('../miniprogram/services/platform.js');
  const session = await import('../miniprogram/services/session.js');

  platform.setPlatform({ login: () => Promise.resolve({ code: 'fake-code' }) });
  try {
    // 后面的 /api/login 在 Node 里必然发不出去（没有 wx.request），
    // 那条路会以「网络失败」结束 —— 关键是**不能**被判成登录超时。
    // 超时给得很宽松，免得机器慢的时候抢在前面，把这条测成假红。
    await assert.rejects(
      () => session.login({ timeoutMs: 5000 }),
      (e) => e && e.code !== 'login_timeout',
      '有 code 的时候不该判成登录超时',
    );
  } finally {
    platform.resetPlatform(platform.originalPlatform);
    session.resetCache();
  }
});

test('退出登录：文案不能说「退出后要重新登记」（那是假的）', () => {
  // 退出只清本机的 token 和缓存，服务端的账号还在 —— openid 一登录就把它找回来。
  // 照着旧文案理解，用户会以为「退出 = 换个昵称重新登记」，点完发现还是老账号，
  // 白折腾一轮（真实发生过）。
  const js = read(path.join(MP, 'pages', 'profile', 'index.js'));
  const modal = /onLogout\(\)[\s\S]{0,900}?\n  \},/m.exec(js);
  assert.ok(modal, '找不到 onLogout');

  // 只看弹窗**真正显示的那句话**。注释里会引用旧文案当反面教材，
  // 拿整段去匹配会把解释本身测红（我已经这样栽过一次）。
  const copy = /content:\s*'([^']*)'/.exec(modal[0]);
  assert.ok(copy, '找不到 showModal 的 content');
  const text = copy[1];

  assert.ok(!/退出后需要重新登记/.test(text),
    '不能再说「退出后需要重新登记」—— 账号不会因为退出而消失');
  assert.match(text, /自动登录/,
    '要说清「再次进入会自动登录」，否则用户会以为退出等于换账号');
  assert.match(modal[0], /clearSession|removeStorage/,
    '退出要真的清掉本机会话');
});

/* ============================================================
   物品照片
   ============================================================ */

test('照片：小程序那边的体积上限必须和服务端一致', async () => {
  const client = await import('../miniprogram/packageAdmin/utils/image-upload.js');
  const server = await import('../server/images.mjs');

  // 客户端也拦一道是为了省流量；两边不一致的话，
  // 「客户端放行、服务端 413」会让用户白等一次上传
  assert.equal(client.MAX_IMAGE_BYTES, server.MAX_IMAGE_BYTES, '体积上限两边不一致');
  assert.equal(client.MAX_IMAGE_BASE64, server.MAX_IMAGE_BASE64, 'base64 上限两边不一致');
});

test('照片：图片地址在模拟器和真机上各自拼对', async () => {
  const { imageUrl } = await import('../miniprogram/utils/format.js');
  const { BASE_URL } = await import('../miniprogram/config.js');
  const { pickBaseUrl } = await import('../miniprogram/config.js');

  // 在 Node 里读不到 wx，所以 BASE_URL 保守取线上地址 —— 这正是设计意图
  assert.equal(imageUrl({ image: 'img_abc.jpg' }), `${BASE_URL}/images/img_abc.jpg`);

  // 没有照片时必须是空串，模板靠它决定回落 emoji（返回 null 会让 wx:if 也假，
  // 但字符串拼接会拼出 "null" 来）
  for (const item of [null, undefined, {}, { image: null }, { image: '' }]) {
    assert.equal(imageUrl(item), '', `${JSON.stringify(item)} 应当没有图片地址`);
  }

  // ★ 地址是按「跑在哪儿」选的：模拟器连本机，真机连线上。
  //   照片地址复用同一个 BASE_URL，所以不用额外配一遍。
  assert.match(pickBaseUrl({ platform: 'devtools' }), /^http:\/\/127\.0\.0\.1:3000$/);
  assert.match(pickBaseUrl({ platform: 'android' }), /^https:\/\//);
});

test('照片：界面确实把图片渲染出来了，而且没照片时回落 emoji', () => {
  // 五处要显示物品图的地方，一个都不能漏 —— 漏掉的那一页会一直显示 emoji，
  // 而且不报错，只有肉眼能发现
  const sites = [
    'packageBazaar/pages/items/index.wxml',
    'packageBazaar/pages/detail/index.wxml',
    'packageBazaar/pages/my-reservations/index.wxml',
    'packageAdmin/pages/items/index.wxml',
  ];
  for (const f of sites) {
    const src = read(path.join(MP, f));
    assert.match(src, /item\.imageUrl/, `${f} 没有渲染图片`);
    assert.match(src, /thumb-img/, `${f} 缺图片样式类`);
    assert.match(src, /mode="aspectFill"/,
      `${f} 要用 aspectFill —— 手机照片不是正方形，不裁会在卡片里被压扁`);
  }

  // 每一处都必须有回落分支，否则没配图的物品那一格就是空白
  const detail = read(path.join(MP, 'packageBazaar/pages/detail/index.wxml'));
  assert.match(detail, /wx:else[^>]*>\{\{item\.emoji \|\| '🎁'\}\}/s,
    '没有照片时要回落到 emoji');

  // 详情页的大图和小图都要换，只换一处的话弹层里还是 emoji
  assert.equal((detail.match(/thumb-img/g) || []).length, 2,
    '详情页的大图和确认弹层的小图都要显示照片');
});

test('照片：三个页面都算出了 imageUrl（模板不自己拼）', () => {
  // 模板里做不了字符串拼接（BASE_URL 在 JS 里），所以每个渲染图片的页面
  // 都要在 JS 里把 imageUrl 算好塞进 data
  const pages = [
    'packageBazaar/pages/items/index.js',
    'packageBazaar/pages/detail/index.js',
    'packageBazaar/pages/my-reservations/index.js',
    'packageAdmin/pages/items/index.js',
  ];
  for (const f of pages) {
    const src = read(path.join(MP, f));
    assert.match(src, /imageUrl\(/, `${f} 没有算 imageUrl`);
    assert.match(src, /imageUrl[^,}]*\n?\s*[,}]/, `${f} 算完没塞进 data`);
  }
});

test('照片：选图压缩上传只写一遍，两个页面共用', () => {
  const up = read(path.join(MP, 'packageAdmin/utils/image-upload.js'));

  // 微信内置的三个 API，缺一不可
  assert.match(up, /wx\.chooseMedia\(/, '要用 chooseMedia 选图');
  assert.match(up, /sizeType:\s*\['compressed'\]/,
    "★ 必须带 sizeType: ['compressed'] —— 让微信直接给压缩版，比任何补救都管用");
  assert.match(up, /wx\.compressImage\(/, '要再压一道兜底');

  // 取消不是错误：用户点了取消不该弹提示
  assert.match(up, /cancelled:\s*true/, '取消要和失败区分开');

  // 压缩失败不能变成「传不了图」
  assert.match(up, /fail:\s*\(\)\s*=>\s*resolve\(src\)/, '压缩失败要回落到原图');

  // 传图要转圈，不然一两秒没反馈像是点空了
  assert.match(up, /wx\.showLoading\(/, '上传要有 loading');
  assert.match(up, /wx\.hideLoading\(/, '别让 loading 留在屏幕上');

  // 两张页面都要用它，不能各写一份选图逻辑
  for (const f of ['packageAdmin/pages/item-new/index.js', 'packageAdmin/pages/items/index.js']) {
    assert.match(read(path.join(MP, f)), /pickAndUploadImage/, `${f} 没有用共用的上传模块`);
  }

  // 新建物品页只负责把文件名透传给建物品接口，不自己拼 base64
  const form = read(path.join(MP, 'packageAdmin/utils/item-form.js'));
  assert.match(form, /image/, '表单要带上 image 字段');
  assert.ok(!/base64/i.test(form), '表单模块不该碰 base64 —— 那是上传模块的事');
});

test('照片：已建的物品必须能换图', () => {
  // 物品删不掉（只能下架），所以图一旦配错，没有换图按钮就永远错着
  const js = read(path.join(MP, 'packageAdmin/pages/items/index.js'));
  assert.match(js, /changeImage/, '物品名额页要有换图入口');
  assert.match(js, /api|patch/, '换图要真的发出去');

  const wxml = read(path.join(MP, 'packageAdmin/pages/items/index.wxml'));
  assert.match(wxml, /bindtap="changeImage"/);

  // 已经有图时要能选「不要图片了」—— 否则「换图」没法表达"删掉"
  assert.match(js, /不要图片了|clearImage/, '要能清空图片');
});


