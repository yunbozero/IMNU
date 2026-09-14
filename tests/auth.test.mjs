/**
 * 鉴权层单元测试。
 * 这些都不需要联网、不需要小程序账号，因为 session provider 是可注入的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signToken, verifyToken, parseBearer,
  createWechatSessionProvider, createFakeSessionProvider,
  createRateLimiter, WECHAT_SESSION_ENDPOINT,
} from '../server/auth.mjs';

const SECRET = 'test-secret-at-least-16-chars';

/* ============================================================
   Token
   ============================================================ */

test('token：签发后能验回来', () => {
  const t = signToken({ uid: 'u_1', scope: 'user' }, SECRET);
  const p = verifyToken(t, SECRET);
  assert.equal(p.uid, 'u_1');
  assert.equal(p.scope, 'user');
  assert.ok(p.exp > Date.now());
  assert.ok(p.jti, '应当带一个唯一 id，方便日后做登出黑名单');
});

test('token：登记用的 token 也要能验回来（它的 uid 故意是 null）', () => {
  // 新用户只登录还没登记，此时没有 uid，靠 openid 认人。
  // 这里曾经写成无脑要求 uid，导致新用户永远走不到登记那一步。
  const t = signToken({ uid: null, openid: 'openid:abc', scope: 'register' }, SECRET);
  const p = verifyToken(t, SECRET);
  assert.ok(p, 'register 作用域的 token 必须能通过校验');
  assert.equal(p.openid, 'openid:abc');
  assert.equal(p.uid, null);
  assert.equal(p.scope, 'register');
});

test('token：register 作用域但没有 openid 的一律拒绝', () => {
  for (const payload of [
    { uid: null, scope: 'register' },
    { uid: null, openid: '', scope: 'register' },
    { uid: null, openid: 123, scope: 'register' },
  ]) {
    assert.equal(verifyToken(signToken(payload, SECRET), SECRET), null,
      `${JSON.stringify(payload)} 应当被拒`);
  }
});

test('token：user 作用域没有 uid 的拒绝', () => {
  assert.equal(verifyToken(signToken({ scope: 'user' }, SECRET), SECRET), null);
  assert.equal(verifyToken(signToken({ uid: '', scope: 'user' }, SECRET), SECRET), null);
});

test('token：换一个 secret 就验不过', () => {
  const t = signToken({ uid: 'u_1' }, SECRET);
  assert.equal(verifyToken(t, 'another-secret-16chars'), null);
});

test('token：改一个字符就失效（签名保护完整性）', () => {
  const t = signToken({ uid: 'u_1', scope: 'user' }, SECRET);

  // 改 payload
  const [data, sig] = t.split('.');
  const tampered = Buffer.from(
    JSON.stringify({ uid: 'u_999', scope: 'user', exp: Date.now() + 1e6 })
  ).toString('base64url');
  assert.equal(verifyToken(`${tampered}.${sig}`, SECRET), null, '改 payload 必须被发现');

  // 改签名
  const badSig = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  assert.equal(verifyToken(`${data}.${badSig}`, SECRET), null, '改签名必须被发现');
});

test('token：过期就失效', () => {
  const t = signToken({ uid: 'u_1' }, SECRET, -1000);   // 一毫秒前就过期了
  assert.equal(verifyToken(t, SECRET), null);
});

test('token：各种畸形输入都返回 null 而不是抛异常', () => {
  for (const bad of [null, undefined, '', '.', 'abc', 'abc.', '.abc', 'a.b.c',
                     'not-base64.also-not', 12345, {}]) {
    assert.doesNotThrow(() => verifyToken(bad, SECRET));
    assert.equal(verifyToken(bad, SECRET), null, `输入 ${JSON.stringify(bad)} 应当返回 null`);
  }
});

test('token：没有 secret 时一律不通过（不能默认放行）', () => {
  const t = signToken({ uid: 'u_1' }, SECRET);
  assert.equal(verifyToken(t, ''), null);
  assert.equal(verifyToken(t, null), null);
  assert.equal(verifyToken(t, undefined), null);
});

test('token：Bearer 头解析', () => {
  assert.equal(parseBearer('Bearer abc.def'), 'abc.def');
  assert.equal(parseBearer('Bearer   x  '), 'x');
  assert.equal(parseBearer('bearer abc'), null, '大小写要严格');
  assert.equal(parseBearer('abc'), null);
  assert.equal(parseBearer(undefined), null);
});

/* ============================================================
   code2session
   ============================================================ */

test('登录：成功时能拿到 openid', async () => {
  const calls = [];
  const provider = createWechatSessionProvider({
    appId: 'wxappid',
    appSecret: 'topsecret',
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ openid: 'o_abc', session_key: 'sk' }) };
    },
  });

  const r = await provider.exchange('CODE123');
  assert.equal(r.openid, 'o_abc');
  assert.equal(r.sessionKey, 'sk');

  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith(WECHAT_SESSION_ENDPOINT));
  assert.ok(calls[0].includes('js_code=CODE123'));
  assert.ok(calls[0].includes('appid=wxappid'));
});

test('登录：微信返回 errcode 时要抛错（它是 200 + errcode，不是 HTTP 错误码）', async () => {
  const provider = createWechatSessionProvider({
    appId: 'a', appSecret: 'b',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ errcode: 40029, errmsg: 'invalid code' }),
    }),
  });

  await assert.rejects(() => provider.exchange('bad'), /40029/);
});

test('登录：HTTP 层失败也要抛错', async () => {
  const provider = createWechatSessionProvider({
    appId: 'a', appSecret: 'b',
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
  });
  await assert.rejects(() => provider.exchange('x'), /502/);
});

test('登录：缺少 AppID / AppSecret 时直接拒绝构造（不要静默降级）', () => {
  assert.throws(() => createWechatSessionProvider({ appId: '', appSecret: 'x' }), /WX_APPID/);
  assert.throws(() => createWechatSessionProvider({ appId: 'x', appSecret: '' }), /WX_SECRET/);
});

test('登录：假 provider 让整个 API 能脱网测试', async () => {
  const p = createFakeSessionProvider({ CODE_A: 'openid-A' });
  assert.equal((await p.exchange('CODE_A')).openid, 'openid-A');
  assert.equal((await p.exchange('CODE_B')).openid, 'openid:CODE_B');
  await assert.rejects(() => p.exchange(''), /code/);
});

/* ============================================================
   限流
   ============================================================ */

test('限流：超过窗口内上限就拒绝', () => {
  let t = 1000;
  const rl = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t });

  assert.equal(rl.check('u1').ok, true);
  assert.equal(rl.check('u1').ok, true);
  assert.equal(rl.check('u1').ok, true);

  const blocked = rl.check('u1');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0, '被限流时要告诉客户端等多久');

  // 换个 key 不受影响
  assert.equal(rl.check('u2').ok, true);

  // 窗口滑过去就能继续
  t += 1001;
  assert.equal(rl.check('u1').ok, true);
});

test('限流：窗口是滑动的，不是固定分桶', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });

  rl.check('u1'); t += 600;
  rl.check('u1'); t += 600;      // 此刻第一条已经过期
  assert.equal(rl.check('u1').ok, true, '第一条应当已滑出窗口');
});

test('限流：不同 key 互不干扰，reset 能清空', () => {
  const rl = createRateLimiter({ limit: 1, windowMs: 10_000 });
  rl.check('a'); rl.check('b');
  assert.equal(rl.check('a').ok, false);
  assert.equal(rl.check('b').ok, false);
  rl.reset();
  assert.equal(rl.check('a').ok, true);
  assert.equal(rl.size, 1);
});
