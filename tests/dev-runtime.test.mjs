/**
 * 本地联调开关（DEV_FAKE_LOGIN）的安全性。
 *
 * 背景：微信登录需要 AppID/AppSecret，本地想跑通端到端就得绕过它。
 * 但「能绕过登录」这件事一旦漏到线上，等于任何人都能冒用任何身份 ——
 * 所以这里不是在测功能，是在测**它绝对打不开生产**。
 *
 * 每条断言都配了「同一个环境换掉那一个变量就该成功」的对照，
 * 否则断言可能是被别的原因拦下的，绿灯说明不了什么。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntime, startServer } from '../server/http.mjs';
import { openMigrated, DEV_DB_PATH } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import { assertLocalOnly, seedDemoData, DEMO } from '../scripts/seed-dev.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 一份合法的线上配置 */
const PROD = {
  NODE_ENV: 'production',
  DB_PATH: '/srv/bazaar/data/bazaar.db',
  SESSION_SECRET: 'a'.repeat(64),
  WX_APPID: 'wxreal',
  WX_SECRET: 'secret',
};

test('运行时：没给 SESSION_SECRET 就拒绝启动', () => {
  assert.throws(() => resolveRuntime({}), /SESSION_SECRET/);
});

test('运行时：给了密钥但没配微信密钥 → 能起，但登录会失败并给出提示', async () => {
  const rt = resolveRuntime({ SESSION_SECRET: 'b'.repeat(64) });
  assert.match(rt.warning, /WX_APPID/, '应当提示登录会失败');
  await assert.rejects(() => rt.sessions.exchange('x'), /WX_APPID/);
});

test('运行时：本地假登录可用，且不需要微信密钥、不需要 SESSION_SECRET', async () => {
  const rt = resolveRuntime({ DEV_FAKE_LOGIN: '1' });
  assert.equal(rt.fakeLogin, true);
  assert.match(rt.warning, /假登录/, '假登录这种状态必须显式警告，不能静默');

  // 任意 code 都能换出 openid —— 这正是本地切换测试角色的方式
  const a = await rt.sessions.exchange('dev-a');
  const b = await rt.sessions.exchange('dev-b');
  assert.equal(a.openid, 'openid:dev-a');
  assert.notEqual(a.openid, b.openid, '不同 code 必须是不同的人，否则没法测多角色');

  // 默认库落到 gitignore 掉的 tmp/，不会污染仓库，也不会去碰 /srv
  assert.match(rt.dbPath, /tmp\//, '本地默认库应当在 tmp/ 下');
});

test('运行时：★ 假登录 + NODE_ENV=production 必须拒绝启动', () => {
  // 两组只差 NODE_ENV 一个变量（库都放在本地），这样拦下来的原因才唯一
  const base = { DB_PATH: 'tmp/x.db', SESSION_SECRET: 'a'.repeat(64), DEV_FAKE_LOGIN: '1' };

  assert.equal(resolveRuntime(base).fakeLogin, true, '没有 NODE_ENV=production 时应当能起');

  assert.throws(
    () => resolveRuntime({ ...base, NODE_ENV: 'production' }),
    /NODE_ENV=production/,
    '生产环境绝不能启用假登录'
  );
});

test('运行时：★ 假登录 + 线上数据目录也必须拒绝启动（第二道锁）', () => {
  assert.throws(
    () => resolveRuntime({ DEV_FAKE_LOGIN: '1', DB_PATH: '/srv/bazaar/data/bazaar.db' }),
    /线上数据目录/,
    '就算 NODE_ENV 没设，指向线上库也不该放过'
  );
  // 对照：同样的假登录，库在别处就正常
  assert.equal(resolveRuntime({ DEV_FAKE_LOGIN: '1', DB_PATH: 'tmp/x.db' }).fakeLogin, true);
});

test('运行时：假登录优先于真密钥（本地带着线上密钥跑也不会走真接口）', async () => {
  const rt = resolveRuntime({ DEV_FAKE_LOGIN: '1', WX_APPID: 'wxreal', WX_SECRET: 's' });
  // 真 provider 会去请求微信；能立刻返回说明走的是假登录
  assert.equal((await rt.sessions.exchange('anything')).openid, 'openid:anything');
});

test('运行时：线上配置正常走真 provider，且 fakeLogin 为假', () => {
  const rt = resolveRuntime(PROD);
  assert.equal(rt.fakeLogin, false);
  assert.equal(rt.dbPath, '/srv/bazaar/data/bazaar.db');
  assert.equal(typeof rt.sessions.exchange, 'function');
  assert.equal(rt.warning, null, '线上配置不该有任何警告');
});

test('运行时：单元文件必须写死 NODE_ENV=production —— 否则第一道锁是空的', () => {
  // 这条锁的强度直接依赖 systemd 单元。少了它，
  // 「假登录 + 生产」就只剩数据库路径一道锁了。
  const unit = fs.readFileSync(path.join(ROOT, 'deploy', 'bazaar.service'), 'utf8');
  assert.match(unit, /^Environment=NODE_ENV=production$/m,
    'bazaar.service 必须设置 NODE_ENV=production，resolveRuntime 的第一道锁靠它');
});

test('运行时：★ 本地联调的配方真的能登录（health → login → register → /api/me）', async () => {
  // 上面测的是「开关选得对」，这条测「选了之后真的能用」——
  // 本地联调清单就是照这个配方写的，配方不成立的话清单会误导人。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-dev-'));
  const dbPath = path.join(dir, 'bazaar.db');

  // 本地配方：只给一个开关，SESSION_SECRET 和微信密钥都不给
  const rt = resolveRuntime({ DEV_FAKE_LOGIN: '1', DB_PATH: dbPath });

  const srv = await startServer({
    port: 0, host: '127.0.0.1',
    dbPath: rt.dbPath, secret: rt.secret, sessions: rt.sessions,
    log: () => {},
  });

  const base = `http://127.0.0.1:${srv.port}`;
  const call = async (method, p, { token, body } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + p, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* 非 JSON */ }
    return { status: res.status, body: parsed };
  };

  try {
    const health = await call('GET', '/api/health');
    assert.equal(health.body.ok, true, 'health 必须通');

    // 假登录：随便一个 code 就是一个独立的人，这是本地切换测试角色的方式
    const login = await call('POST', '/api/login', { body: { code: 'dev-alice' } });
    assert.equal(login.body.ok, true, JSON.stringify(login.body));
    assert.ok(login.body.token, '假登录也应当签发 token');

    const reg = await call('POST', '/api/register', {
      token: login.body.token, body: { sid: '2023001', name: '测试同学' },
    });
    assert.equal(reg.body.ok, true, JSON.stringify(reg.body));

    const me = await call('GET', '/api/me', { token: reg.body.token });
    assert.equal(me.body.ok, true, '带 token 访问受保护接口必须成功');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('种子数据：★ 生产环境必须拒绝运行', () => {
  assert.throws(() => assertLocalOnly({ NODE_ENV: 'production' }, 'tmp/x.db'), /NODE_ENV=production/);
  assert.throws(() => assertLocalOnly({}, '/srv/bazaar/data/bazaar.db'), /线上路径/);
  // 对照：本地配置就该放行，否则这个守卫就成了「什么都不能跑」
  assertLocalOnly({}, DEV_DB_PATH);
});

test('种子数据：能造出活动和物品，重复跑不会翻倍', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imnu-seed-'));
  const db = openMigrated(path.join(dir, 'b.db'));
  const repo = createSqliteRepository(db);

  try {
    const first = seedDemoData(repo);
    assert.equal(first.skipped, false, '空库应当造数据');
    assert.ok(first.items >= 6, `演示物品太少（${first.items} 个），测不出列表和约满状态`);

    const ev = repo.getActiveEvent();
    assert.ok(ev, '必须造出一个在售活动，否则小程序首页是空的');
    assert.equal(repo.listItems(ev.id).length, first.items);
    assert.equal(repo.listStalls(ev.id).length, first.stalls);

    // 演示志愿者要能按 code 登录 —— 假登录把 code 映射成 openid:<code>
    assert.ok(repo.findUserByOpenid('openid:dev-volunteer'),
      '演示志愿者应当存在，且 openid 必须是 openid:<code> 的形式，否则凭 code 登不进去');

    const second = seedDemoData(repo);
    assert.equal(second.skipped, true, '重复跑必须跳过');
    assert.equal(repo.listItems(ev.id).length, first.items, '物品数量不该翻倍');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('种子数据：每个 tint 都在 app.wxss 里有对应的色底类', () => {
  // tint 写错不会报错，只是卡片没有背景色 —— 很难一眼看出来
  const wxss = fs.readFileSync(path.join(ROOT, 'miniprogram', 'app.wxss'), 'utf8');
  for (const it of DEMO.items) {
    assert.match(wxss, new RegExp(`\\.${it.tint}\\s*\\{`),
      `演示物品「${it.name}」用了 .${it.tint}，但 app.wxss 里没有这个类，卡片会没有背景色`);
  }
});

test('联调清单：文档在，里面的命令真实存在，关键警告没丢', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'local-dev.md'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  // 清单让人跑的命令，必须在 package.json 里真的有，否则照着走第一步就断
  assert.ok(pkg.scripts.seed, 'package.json 必须暴露 seed 脚本（清单里写了 npm run seed）');
  assert.ok(pkg.scripts.start, 'package.json 必须暴露 start 脚本');

  // 三个最容易踩的点，文档里不能少
  assert.match(doc, /DEV_FAKE_LOGIN/, '要讲清楚假登录怎么开');
  assert.match(doc, /不校验合法域名/, '不勾这个所有请求都会失败 —— 必须提醒');
  assert.match(doc, /miniprogram/, '必须说明导入的是哪一层目录');
  assert.match(doc, /绝不可用|不能上线|绝不能上/, '必须警告假登录和种子数据不能上线');
});
