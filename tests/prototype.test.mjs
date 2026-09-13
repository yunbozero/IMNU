/**
 * 原型验证
 *   1. 合规红线  —— 界面里不允许出现任何交易/金额用语（个人主体小程序硬约束）
 *   2. 结构完整性 —— 资源引用与页面内链不能断，页面关键节点不能丢
 *   3. 核心逻辑   —— 用 vm 加载 assets/app.js，验证名额扣减/释放与核销状态机
 *
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTO = path.join(ROOT, 'prototype');
const PAGES = path.join(PROTO, 'pages');

const read = (p) => fs.readFileSync(p, 'utf8');
const pagePath = (f) => path.join(PAGES, f);
const listPages = () => fs.readdirSync(PAGES).filter((f) => f.endsWith('.html'));

/* ============================================================
   1. 合规红线
   ============================================================ */

/** 绝对禁止出现的词：出现即说明界面在暗示线上交易 */
const FORBIDDEN_WORDS = [
  '价格', '金额', '下单', '订单', '购买', '购物车', '结算',
  '库存', '发货', '收货', '支付', '价目', '售价',
];

/** 绝对禁止出现的形态：金额数字 */
const FORBIDDEN_PATTERNS = [
  { re: /¥/, label: '人民币符号 ¥' },
  { re: /\d+\s*元/, label: '金额数字（N元）' },
  { re: /\d+\s*块\s*[钱\d]/, label: '金额数字（N块）' },
];

test('合规：原型界面不出现任何交易或金额用语', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(html|js|css)$/.test(e.name)) files.push(full);
    }
  };
  walk(PROTO);
  assert.ok(files.length >= 8, '应当扫描到原型文件');

  const problems = [];
  for (const f of files) {
    const src = read(f);
    const rel = path.relative(ROOT, f);
    for (const w of FORBIDDEN_WORDS) {
      if (src.includes(w)) problems.push(`${rel} 出现禁用词「${w}」`);
    }
    for (const { re, label } of FORBIDDEN_PATTERNS) {
      const m = src.match(re);
      if (m) problems.push(`${rel} 出现${label}：${JSON.stringify(m[0])}`);
    }
  }
  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

test('合规：物品数据不含任何金额字段', () => {
  const src = read(path.join(PROTO, 'assets', 'data.js'));
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;globalThis.__ITEMS = ITEMS; globalThis.__EVENT = EVENT;', sandbox);

  const banned = /price|amount|money|cost|fee|yuan|rmb|金额|价格/i;
  for (const it of sandbox.__ITEMS) {
    for (const k of Object.keys(it)) {
      assert.ok(!banned.test(k), `物品 ${it.id} 的字段 ${k} 疑似金额字段`);
    }
  }
  for (const k of Object.keys(sandbox.__EVENT)) {
    assert.ok(!banned.test(k), `活动字段 ${k} 疑似金额字段`);
  }
});

test('合规：三处关键页面都带「仅登记名额、不收费」声明', () => {
  for (const f of ['s1-signup.html', 's3-item-detail.html', 's5-success.html']) {
    const src = read(pagePath(f));
    assert.ok(/(仅|只)(登记|锁定)[^。]{0,6}名额/.test(src), `${f} 缺少合规声明`);
  }
});

/* ============================================================
   2. 结构完整性
   ============================================================ */

test('结构：页面文件齐全', () => {
  const expected = [
    's1-signup.html', 's2-items.html', 's3-item-detail.html', 's5-success.html',
    's6-my-reservations.html', 's7-pickup-code.html', 's8-profile.html',
    'v1-scan.html', 'v3-result.html',
  ];
  const actual = listPages();
  for (const f of expected) assert.ok(actual.includes(f), `缺少页面 ${f}`);
});

test('结构：所有资源引用与页面内链都存在', () => {
  const problems = [];
  const targets = [path.join(PROTO, 'index.html'), ...listPages().map(pagePath)];

  for (const file of targets) {
    const src = read(file);
    const rel = path.relative(ROOT, file);
    const attrs = [
      ...src.matchAll(/(?:href|src)="([^"]+)"/g),
      ...src.matchAll(/data-src="([^"]+)"/g),
    ];
    for (const [, url] of attrs) {
      if (/^(https?:|mailto:|data:|#|javascript:)/.test(url)) continue;
      const clean = url.split('?')[0].split('#')[0];
      if (!clean) continue;
      const resolved = path.resolve(path.dirname(file), clean);
      if (!fs.existsSync(resolved)) {
        problems.push(`${rel} → ${url}（找不到 ${path.relative(ROOT, resolved)}）`);
      }
    }
  }
  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

test('结构：页面关键节点存在（防止改动时改坏契约）', () => {
  const contract = {
    's2-items.html': ['grid', 'stall-tabs', 'q'],
    's3-item-detail.html': ['ab-btn', 'sheet-reserve', 's-submit', 'stepper'],
    's6-my-reservations.html': ['list', 'tabs'],
    's7-pickup-code.html': ['qr', 'code', 'cancel', 'status-card'],
    'v1-scan.html': ['scan', 'pad', 'slots', 'keys', 'records'],
    'v3-result.html': ['screen', 'title', 'detail'],
  };
  for (const [file, ids] of Object.entries(contract)) {
    const src = read(pagePath(file));
    for (const id of ids) {
      assert.ok(src.includes(`id="${id}"`), `${file} 缺少 id="${id}"`);
    }
  }
});

test('结构：所有 JS（含内联脚本）语法正确', () => {
  const problems = [];

  const check = (code, label) => {
    try {
      new vm.Script(code, { filename: label });
    } catch (e) {
      problems.push(`${label} 语法错误：${e.message}`);
    }
  };

  for (const f of ['assets/data.js', 'assets/app.js']) {
    check(read(path.join(PROTO, f)), f);
  }

  for (const f of listPages()) {
    const src = read(pagePath(f));
    const inline = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    inline.forEach(([, code], i) => check(code, `${f} 内联脚本 #${i + 1}`));
  }

  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

/* ============================================================
   3. 核心逻辑（把 app.js 放进 vm 跑）
   ============================================================ */

function loadBZ() {
  const src =
    read(path.join(PROTO, 'assets', 'data.js')) + '\n' +
    read(path.join(PROTO, 'assets', 'app.js')) + '\n' +
    ';globalThis.__BZ = BZ;';

  const store = new Map();
  const noop = () => {};
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    window: { addEventListener: noop },
    location: { pathname: '/prototype/pages/s2-items.html', search: '', replace: noop, href: '' },
    document: {
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({
        classList: { add: noop, remove: noop },
        style: {}, appendChild: noop,
      }),
      body: { appendChild: noop },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'app.js' });
  return sandbox.__BZ;
}

const SIGNED_IN = (bz) => bz.signup('2021123456', '测试同学');

test('逻辑：预置的已核销记录必须带核销时间（否则界面显示成「—」）', () => {
  const bz = loadBZ();
  const done = bz.allReservations().filter((r) => r.status === 'redeemed');
  assert.ok(done.length >= 1, '应当有预置的已核销记录');

  for (const r of done) {
    assert.ok(r.redeemedAt, `${r.id} 缺少 redeemedAt`);
    assert.equal(bz.timeText(r.redeemedAt).includes('—'), false);
    assert.equal(bz.clockText(r.redeemedAt), bz.clockText(r.redeemedAt));
    assert.notEqual(bz.clockText(r.redeemedAt), '—');
  }
});

test('逻辑：未登记的页面不会读到别人的预定', () => {
  const bz = loadBZ();
  // 注意：bz 在 vm 的另一个 realm 里，数组原型不同，不能用 deepEqual 比较空数组
  assert.equal(bz.mine().length, 0, '没登记时应看不到任何预定');
  assert.equal(bz.myReservationFor('i1'), null);
  assert.ok(bz.allReservations().length > 0, '但种子里的其他人预定仍然存在');
});

test('逻辑：未登记时不能预定', () => {
  const bz = loadBZ();
  const res = bz.reserve('i3', 1);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'noauth');
});

test('逻辑：预定成功会扣减名额并生成 6 位取货码', () => {
  const bz = loadBZ();
  SIGNED_IN(bz);
  const before = bz.item('i3').remaining;

  const res = bz.reserve('i3', 2);
  assert.equal(res.ok, true);
  assert.equal(bz.item('i3').remaining, before - 2, '名额应扣减 2');
  assert.match(res.reservation.code, /^\d{6}$/, '取货码应为 6 位数字');
  assert.equal(res.reservation.status, 'reserved');
});

test('逻辑：约满的物品预定时被拒绝（防超卖）', () => {
  const bz = loadBZ();
  SIGNED_IN(bz);
  assert.equal(bz.item('i2').remaining, 0);

  const res = bz.reserve('i2', 1);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'soldout');
  assert.equal(bz.item('i2').remaining, 0, '失败时名额不能被扣成负数');
});

test('逻辑：同一件物品不能重复预定', () => {
  const bz = loadBZ();
  SIGNED_IN(bz);

  assert.equal(bz.reserve('i3', 1).ok, true);
  const second = bz.reserve('i3', 1);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'dup');
});

test('逻辑：取消预定会把名额还回去，且不能重复取消', () => {
  const bz = loadBZ();
  SIGNED_IN(bz);
  const before = bz.item('i3').remaining;

  const r = bz.reserve('i3', 2).reservation;
  assert.equal(bz.item('i3').remaining, before - 2);

  assert.equal(bz.cancel(r.id).ok, true);
  assert.equal(bz.item('i3').remaining, before, '取消后名额应恢复');

  const again = bz.cancel(r.id);
  assert.equal(again.ok, false, '重复取消必须失败，否则名额会虚增');
  assert.equal(bz.item('i3').remaining, before, '重复取消不能再加名额');
});

test('逻辑：核销是单向状态转换，同一码只能用一次', () => {
  const bz = loadBZ();
  SIGNED_IN(bz);
  const r = bz.reserve('i3', 1).reservation;

  const first = bz.redeem(r.code, '志愿者 A');
  assert.equal(first.ok, true);
  assert.equal(bz.reservation(r.id).status, 'redeemed');
  assert.equal(bz.reservation(r.id).operator, '志愿者 A');

  const second = bz.redeem(r.code, '志愿者 B');
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'redeemed');
  assert.equal(bz.reservation(r.id).operator, '志愿者 A', '第二次核销不能覆盖操作人');
});

test('逻辑：无效取货码被拒绝', () => {
  const bz = loadBZ();
  SIGNED_IN(bz);
  const res = bz.redeem('000000', '志愿者 A');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid');
});

test('逻辑：已取消的预定不能核销', () => {
  const bz = loadBZ();
  SIGNED_IN(bz);
  const r = bz.reserve('i3', 1).reservation;
  bz.cancel(r.id);

  const res = bz.redeem(r.code, '志愿者 A');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'cancelled');
});

test('逻辑：名额为 1 的物品，被预定后即约满', () => {
  const bz = loadBZ();
  SIGNED_IN(bz);
  assert.equal(bz.item('i6').remaining, 1);

  assert.equal(bz.reserve('i6', 1).ok, true);
  assert.equal(bz.item('i6').remaining, 0);

  // 换个账号（模拟另一位同学）应当被拒绝
  bz.signup('2021999999', '另一位同学');
  const res = bz.reserve('i6', 1);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'soldout');
});

test('逻辑：取货码分组展示', () => {
  const bz = loadBZ();
  assert.equal(bz.groupCode('482913'), '482 913');
  assert.equal(bz.groupCode('12345'), '123 45');
});
