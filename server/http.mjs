/**
 * HTTP 入口。
 *
 * 职责：路由、鉴权中间件、限流、JSON 编解码、日志。业务逻辑全在 api.mjs，
 * 数据访问全在 repository.mjs。
 *
 *   npm start            # 或 node server/http.mjs
 *
 * 需要的环境变量：
 *   SESSION_SECRET  必填，签发 token 用。生成：openssl rand -hex 32
 *   DB_PATH         默认 /srv/bazaar/data/bazaar.db（DEV_FAKE_LOGIN=1 时默认 tmp/bazaar-dev.db）
 *   PORT            默认 3000
 *   WX_APPID / WX_SECRET   换 openid 用；不填则登录接口直接报错
 *   NODE_ENV=production
 *   DEV_FAKE_LOGIN=1       仅本地联调：任何 code 都能登录。生产用不了，见 resolveRuntime
 */
import http from 'node:http';
import { createApi } from './api.mjs';
import {
  verifyToken, parseBearer, signToken,
  createWechatSessionProvider, createFakeSessionProvider, createRateLimiter,
} from './auth.mjs';
import { openMigrated, PROD_DB_PATH, DEV_DB_PATH } from './db.mjs';
import { createSqliteRepository } from './repository.mjs';
import {
  readImage, mimeOfName, MAX_IMAGE_BASE64,
  PROD_IMAGE_DIR, DEV_IMAGE_DIR,
} from './images.mjs';

/** 请求体上限。义卖接口的 body 都是几十字节，64KB 已经很宽松。 */
const MAX_BODY_BYTES = 64 * 1024;
/** 超出这个量就直接断开，不再陪它把数据读完。 */
const HARD_BODY_LIMIT = 1024 * 1024;

/**
 * 传图那条路的请求体上限：base64 之后的图片 + JSON 外壳的余量。
 * 单列出来是因为它比普通接口大两个数量级 —— 拿 64KB 去卡它，
 * 用户会看到「请求体过大」，而图片其实完全正常。
 *
 * ★ 导出是为了让部署测试能断言「nginx 的 client_max_body_size 必须比它大」：
 *   反过来的话，超限请求会被 nginx 挡掉，用户看到的是 HTML 错误页而不是我们的提示。
 */
export const MAX_IMAGE_BODY_BYTES = MAX_IMAGE_BASE64 + 8 * 1024;

/** 物品照片的 URL 前缀。生产环境 nginx 直接发它，Node 这边兜本地开发。 */
const IMAGE_PREFIX = '/images/';

/** 路由表。auth: none | register | user；rateLimit 只加在写操作上。 */
export const ROUTES = {
  'GET /api/health': { handler: 'health', auth: 'none' },
  'GET /api/event': { handler: 'getEvent', auth: 'none' },
  'GET /api/items': { handler: 'listItems', auth: 'none' },
  'POST /api/login': { handler: 'login', auth: 'none' },
  'POST /api/register': { handler: 'register', auth: 'register' },
  'GET /api/me': { handler: 'me', auth: 'user' },
  'GET /api/reservations': { handler: 'listMyReservations', auth: 'user' },
  'POST /api/reserve': { handler: 'reserve', auth: 'user', rateLimit: true },
  'POST /api/cancel': { handler: 'cancel', auth: 'user' },
  'POST /api/redeem': { handler: 'redeem', auth: 'user' },

  // 管理端。门槛（二级管理员 / 一级管理员 / 超管）在 api.mjs 里逐个判断，
  // 这里只保证「必须先登录」。
  'POST /api/admin/item': { handler: 'adminUpdateItem', auth: 'user' },
  'POST /api/admin/item/create': { handler: 'adminCreateItem', auth: 'user' },
  // 传图：body 是 base64 的 JSON，所以上限要单独放宽
  'POST /api/admin/image': {
    handler: 'adminUploadImage', auth: 'user', maxBytes: MAX_IMAGE_BODY_BYTES,
  },
  'POST /api/admin/cancel': { handler: 'adminCancel', auth: 'user' },
  'POST /api/admin/undo-redeem': { handler: 'adminUndoRedeem', auth: 'user' },
  'POST /api/admin/role': { handler: 'adminSetRole', auth: 'user' },
  'POST /api/admin/transfer-owner': { handler: 'adminTransferOwner', auth: 'user' },
  'GET /api/admin/reservations': { handler: 'adminReservations', auth: 'user' },
  'GET /api/admin/settings': { handler: 'adminGetSettings', auth: 'user' },
  'POST /api/admin/settings': { handler: 'adminSetSettings', auth: 'user' },
};

/**
 * 读请求体。
 *
 * hardLimit 默认由 maxBytes 推出来（至少 1MB、且是 maxBytes 的两倍）——
 * ★ 不能让传图那条路沿用固定的 1MB 硬上限：它的 maxBytes 是 2.8MB，
 *   硬上限却停在 1MB 的话，一张正常的图会在 1MB 处被 destroy，
 *   客户端收到「连接被重置」，而不是能看懂的 413。
 */
function readBody(req, { maxBytes = MAX_BODY_BYTES, hardLimit = Math.max(HARD_BODY_LIMIT, maxBytes * 2) } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];

    req.on('data', (c) => {
      size += c.length;

      if (size > hardLimit) {
        reject(Object.assign(new Error('body too large'), { code: 'too_large' }));
        req.destroy();
        return;
      }

      if (size > maxBytes) {
        // ★ 超限但还不算离谱：把剩下的读完再回 413。
        //   直接 destroy 的话，客户端收到的是「连接被重置」而不是 413，
        //   小程序那边只能显示「网络错误」，根本看不出是请求太大了。
        if (!tooLarge) { tooLarge = true; chunks.length = 0; }
        return;
      }

      chunks.push(c);
    });

    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('body too large'), { code: 'too_large' }));
        return;
      }
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid json'), { code: 'bad_json' }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

/** 非 JSON 响应（目前只有 CSV 名单导出用） */
function sendRaw(res, status, contentType, text) {
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

/**
 * 发一张物品照片。
 *
 * ★ 生产环境走不到这里：nginx 有 `/images/` 的 location，直接读同一个目录发文件，
 *   比让 Node 读进内存再吐出去快得多。这个分支是给**本地开发**用的 ——
 *   开发者工具连的是 Node 自己，没有 nginx，没有它整个界面都是碎图。
 *
 * ★ 名字不做 URL 解码，直接交给 readImage 校验。我们的文件名是纯十六进制加扩展名，
 *   本来就不需要百分号编码；不去解码反而省掉了 `decodeURIComponent('%')` 抛异常
 *   这个坑，凡是编码过的路径一律匹配不上、返回 404。
 */
function sendImage(res, pathname, imageDir) {
  const buf = readImage(pathname.slice(IMAGE_PREFIX.length), imageDir);
  if (!buf) {
    send(res, 404, { ok: false, error: 'not_found', message: '图片不存在' });
    return 404;
  }

  res.writeHead(200, {
    'content-type': mimeOfName(pathname.slice(IMAGE_PREFIX.length)),
    'content-length': buf.length,
    // 文件名是随机串、内容永不改变，所以可以放心长缓存 ——
    // 换图是换一个新文件名，不会出现「换了图但客户端还看旧的」
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  res.end(buf);
  return 200;
}

/**
 * 从 token 解析出身份。
 * scope='register' 的 token 只能拿去注册；scope='user' 的必须能在库里查到人。
 */
function resolveAuth(token, secret, repo) {
  const payload = verifyToken(token, secret);
  if (!payload) return { auth: null, user: null };

  if (payload.scope === 'register') {
    return { auth: { scope: 'register', openid: payload.openid }, user: null };
  }
  if (!payload.uid) return { auth: null, user: null };

  const user = repo.findUserById(payload.uid);
  if (!user) return { auth: null, user: null };   // 人已经被删了，token 作废

  return { auth: { scope: 'user', uid: user.id }, user };
}

/** 日志里的取货码打码。取货码等同于提货凭证，不该明文落到 journald 里。 */
function maskCode(v) {
  if (typeof v !== 'string') return v;
  return v.length <= 2 ? '**' : `**${v.slice(-2)}`;
}

export function createRequestHandler({
  repo, sessions, secret,
  version = '1.0.0',
  startedAt = Date.now(),
  now = Date.now,
  log = () => {},
  makeCode,
  maxItemsPerUser = 0,
  imageDir = PROD_IMAGE_DIR,
  rateLimiter = createRateLimiter({ limit: 10, windowMs: 10_000, now }),
} = {}) {
  if (!repo) throw new Error('需要 repo');
  if (!secret) throw new Error('需要 SESSION_SECRET');

  const api = createApi({
    repo, sessions, secret, signToken, startedAt, now, makeCode, maxItemsPerUser, imageDir,
  });

  return async function handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url || '/', 'http://localhost');
    const routeKey = `${req.method} ${url.pathname}`;
    let status = 500;
    let uid = null;

    try {
      // 物品照片：静态文件，不是接口，所以不进路由表（路由表是精确匹配的）
      if (req.method === 'GET' && url.pathname.startsWith(IMAGE_PREFIX)) {
        status = sendImage(res, url.pathname, imageDir);
        return;
      }

      const route = ROUTES[routeKey];

      if (!route) {
        // 路径存在但方法不对，给 405 而不是 404 —— 排障时区别很大
        const samePath = Object.keys(ROUTES).some((k) => k.endsWith(` ${url.pathname}`));
        status = samePath ? 405 : 404;
        send(res, status, {
          ok: false,
          error: samePath ? 'method_not_allowed' : 'not_found',
          message: samePath ? '请求方法不对' : '接口不存在',
        });
        return;
      }

      const token = parseBearer(req.headers.authorization);
      const { auth, user } = resolveAuth(token, secret, repo);
      uid = user ? user.id : null;

      // 鉴权闸门
      if (route.auth === 'register' && (!auth || auth.scope !== 'register')) {
        status = 401;
        send(res, status, { ok: false, error: 'unauthorized', message: '请先登录' });
        return;
      }
      if (route.auth === 'user' && !user) {
        status = 401;
        send(res, status, { ok: false, error: 'unauthorized', message: '请先登录' });
        return;
      }

      // 限流：只加在写操作上，按人计数
      let rateLimited = false;
      if (route.rateLimit) {
        const r = rateLimiter.check(user.id);
        if (!r.ok) {
          status = 429;
          send(res, status, {
            ok: false, error: 'rate_limited', message: '操作太频繁，请稍后再试',
          }, { 'retry-after': String(Math.ceil(r.retryAfterMs / 1000)) });
          return;
        }
      }

      const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
      let body = {};
      if (isWrite) {
        try {
          body = await readBody(req, { maxBytes: route.maxBytes || MAX_BODY_BYTES });
        } catch (e) {
          status = e.code === 'too_large' ? 413 : 400;
          send(res, status, {
            ok: false,
            error: e.code === 'too_large' ? 'payload_too_large' : 'bad_request',
            message: e.code === 'too_large' ? '请求体过大' : '请求体不是合法 JSON',
          });
          return;
        }
      }

      const query = Object.fromEntries(url.searchParams.entries());
      const result = await api[route.handler]({
        body, user, auth, rateLimited, query, ip: req.socket.remoteAddress,
      });
      status = result.status;

      if (result.raw) sendRaw(res, status, result.raw.contentType, result.raw.text);
      else send(res, status, result.body);
    } catch (e) {
      status = 500;
      // 服务端 bug：日志里留完整堆栈，但绝不把堆栈返回给客户端
      log({
        level: 'error', msg: 'unhandled', path: url.pathname,
        error: e && e.message, stack: e && e.stack, body: maskBody(req, e),
      });
      if (!res.headersSent) {
        send(res, 500, { ok: false, error: 'internal', message: '服务端出错了' });
      }
    } finally {
      log({
        level: 'info',
        method: req.method,
        path: url.pathname,
        status,
        ms: Date.now() - started,
        uid,
      });
    }
  };
}

function maskBody() { return undefined; }

/* ============================================================
   启动
   ============================================================ */

export function startServer({
  port = 3000, host = '127.0.0.1', dbPath, secret, sessions,
  log = (o) => console.log(JSON.stringify(o)),
  ...rest
} = {}) {
  const db = openMigrated(dbPath);
  const repo = createSqliteRepository(db);
  const handler = createRequestHandler({ repo, sessions, secret, log, ...rest });

  const server = http.createServer(handler);

  // 防慢连接：义卖当天不希望有人用超慢的请求占着连接不放
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 15_000;

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        server,
        db,
        repo,
        port: server.address().port,
        async close() {
          await new Promise((r) => server.close(r));
          db.close();
        },
      });
    });
  });
}

/* ============================================================
   CLI
   ============================================================ */

/** 只在本地假登录模式下使用 —— 那个模式下认证本来就是敞开的 */
const DEV_SECRET = 'dev-only-secret-not-for-production';

/**
 * 决定运行时用哪个会话提供者、哪个库、哪个密钥。
 *
 * 抽成导出的纯函数，是为了**能直接测「假登录不可能在生产被打开」**，
 * 而不是靠人读一遍代码然后相信它 —— 安全开关最怕的就是「看着没问题」。
 *
 *   DEV_FAKE_LOGIN=1  本地联调开关（微信登录要 AppID/AppSecret，本地想跑通端到端得绕过）。
 *                     两道独立的锁，任何一道命中就拒绝启动：
 *                       1. 线上 systemd 单元写死了 NODE_ENV=production
 *                       2. 线上的 DB_PATH 一定在 /srv/bazaar 下
 *                     所以就算有人把本地的环境变量整份抄到服务器上，也起不来。
 */
export function resolveRuntime(env = {}) {
  const fakeLogin = env.DEV_FAKE_LOGIN === '1';
  const dbPath = env.DB_PATH || (fakeLogin ? DEV_DB_PATH : PROD_DB_PATH);

  // 物品照片放哪。和 DB_PATH 同样的规矩：本地联调落在 tmp/ 下（已被 .gitignore 挡掉），
  // 线上在 /srv/bazaar 下。两边都是「普通目录」，所以本地怎么测出来的行为线上一致。
  const imageDir = env.IMAGE_DIR || (fakeLogin ? DEV_IMAGE_DIR : PROD_IMAGE_DIR);

  // 每个账号在本次活动内最多预定几件；0 = 不限。
  // 防囤货的软上限。默认 3，义卖当天可以改环境变量临时调整（改完重启服务）。
  const rawMax = env.MAX_ITEMS_PER_USER === undefined || env.MAX_ITEMS_PER_USER === ''
    ? 3
    : Number(env.MAX_ITEMS_PER_USER);
  if (!Number.isInteger(rawMax) || rawMax < 0) {
    throw new Error('MAX_ITEMS_PER_USER 必须是非负整数（0 表示不限）');
  }

  if (fakeLogin) {
    if (env.NODE_ENV === 'production') {
      throw new Error('拒绝启动：DEV_FAKE_LOGIN=1 与 NODE_ENV=production 同时存在 —— 假登录只能在本地用。');
    }
    if (String(dbPath).includes('/srv/bazaar')) {
      throw new Error(`拒绝启动：DEV_FAKE_LOGIN=1 却指向线上数据目录 ${dbPath} —— 假登录只能在本地用。`);
    }
  }

  const secret = env.SESSION_SECRET || (fakeLogin ? DEV_SECRET : null);
  if (!secret || secret.length < 16) {
    throw new Error('缺少 SESSION_SECRET（至少 16 个字符）。生成：openssl rand -hex 32');
  }

  let sessions;
  let warning = null;

  if (fakeLogin) {
    sessions = createFakeSessionProvider();
    warning = '[!] 已启用本地假登录（DEV_FAKE_LOGIN=1）：任何 code 都能登录。线上绝不可用。';
  } else if (env.WX_APPID && env.WX_SECRET) {
    sessions = createWechatSessionProvider({ appId: env.WX_APPID, appSecret: env.WX_SECRET });
  } else {
    sessions = {
      async exchange() {
        throw new Error('未配置 WX_APPID / WX_SECRET，无法完成微信登录');
      },
    };
    warning = '[!] 未配置 WX_APPID / WX_SECRET，/api/login 会失败。本地联调请设 DEV_FAKE_LOGIN=1';
  }

  return {
    port: Number(env.PORT || 3000),
    host: env.HOST || '127.0.0.1',
    dbPath,
    imageDir,
    secret,
    sessions,
    fakeLogin,
    warning,
    maxItemsPerUser: rawMax,
  };
}

function main() {
  let runtime;
  try {
    runtime = resolveRuntime(process.env);
  } catch (e) {
    console.error(`[x] ${e.message}`);
    process.exit(1);
  }

  const { port, host, dbPath, imageDir, secret, sessions, warning, maxItemsPerUser } = runtime;
  if (warning) console.warn(warning);

  startServer({ port, host, dbPath, imageDir, secret, sessions, maxItemsPerUser }).then(async ({ server, close }) => {
    console.log(`✅ bazaar-api 已启动 http://${host}:${port}`);
    console.log(`   DB ${dbPath}`);
    console.log(`   物品照片 ${imageDir}`);
    console.log(`   每账号最多预定 ${maxItemsPerUser || '不限'} 件`);

    const shutdown = async (sig) => {
      console.log(`收到 ${sig}，正在关闭…`);
      await close();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }).catch((e) => {
    console.error('[x] 启动失败：', e.message);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
