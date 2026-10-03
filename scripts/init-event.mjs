/**
 * 往库里放「真实的」活动数据：活动 + 摊位 + 物品。
 *
 *   node scripts/init-event.mjs deploy/event-config.example.json        # 只出计划，不写库
 *   node scripts/init-event.mjs deploy/event-config.example.json --yes  # 真的写
 *
 * 线上要在服务器上跑，而且**必须用 bazaar 账号**跑：
 *
 *   sudo -u bazaar DB_PATH=/srv/bazaar/data/bazaar.db \
 *     node /srv/bazaar/app/scripts/init-event.mjs /srv/bazaar/event.json --yes
 *
 * 用 root 跑会写出 root 属主的 -wal / -shm 文件，服务（bazaar）之后写不进去，
 * 症状是「核销时好时坏」，而且报错完全指不到权限上。
 *
 * ------------------------------------------------------------------
 * 为什么需要这个脚本
 * ------------------------------------------------------------------
 * 管理端界面只能**改**物品（加减名额、上下架），活动和摊位没有任何创建入口；
 * 而 scripts/seed-dev.mjs 明确拒绝在生产库上跑。
 * 结果就是线上库永远没有活动 —— 小程序打开是「活动还没开始」，一片空白，
 * 而且不管怎么点都建不出东西来。
 *
 * ------------------------------------------------------------------
 * 为什么默认不写库
 * ------------------------------------------------------------------
 * 这是唯一能往生产库加活动的东西，跑错一次就是在真实的库上多出一个活动。
 * 所以默认只打印计划，必须显式加 --yes 才落盘 —— 先看清楚再动手。
 *
 * ------------------------------------------------------------------
 * 可以重复运行
 * ------------------------------------------------------------------
 * 活动、摊位、物品一律**按名字**在本次活动的范围内查重，已经有的就跳过。
 * 所以往配置里追加几行再跑一次，效果是「把新东西补进去」，而不是造出一堆
 * 重复物品。义卖当天临时加东西也可以用这个办法（当然，界面上加更方便）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openMigrated, PROD_DB_PATH } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import {
  ITEM_NAME_MAX, ITEM_DESC_MAX, ITEM_QUOTA_MAX, ITEM_EMOJI_MAX, ITEM_TINTS,
  // ★ 场次和摊位这几个上限和「新建活动/摊位」接口用的是同一份 ——
  //   各写一份的话，界面上建得出来的东西脚本却说不行（或反过来）。
  EVENT_STATUSES, EVENT_NAME_MAX, STALL_NAME_MAX, STALL_LOC_MAX,
} from '../server/api.mjs';
import { parseEventTime, checkRange } from '../server/time.mjs';
import { validateImage, imageProblemText, saveImage, PROD_IMAGE_DIR } from '../server/images.mjs';

export const USAGE = `
用法：
  node scripts/init-event.mjs <配置文件.json>          只看计划，不写库
  node scripts/init-event.mjs <配置文件.json> --yes    确认无误，真的写

目标库取自环境变量 DB_PATH；不设就是线上路径 ${PROD_DB_PATH}。
物品照片存在 IMAGE_DIR；不设就是线上路径 ${PROD_IMAGE_DIR}。
本地试跑：DB_PATH=tmp/bazaar-dev.db IMAGE_DIR=tmp/images node scripts/init-event.mjs <配置文件>

配置文件的格式见 deploy/event-config.example.json。
`.trim();

/* ============================================================
   配置解析
   ============================================================ */

/**
 * `parseEventTime` 现在住在 `server/time.mjs` —— 因为「新建活动」那个接口
 * 也要用它。**两边各写一份是不行的**：同一句「2026-04-18 09:00」
 * 会存成两个不同的时刻，而且只在线上、只在那一种入口下暴露。
 */
const asText = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * 校验并归一化配置。
 * 抛出的错误信息是给人看的 —— 这个脚本的失败现场是 SSH 里的一个终端，
 * 报错必须直接指明是哪一行哪一项写错了。
 */
export function parseConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('配置的顶层必须是一个 JSON 对象');
  }

  /* ---------- 活动 ---------- */
  const ev = raw.event;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    throw new Error('缺少 event 段（活动信息）');
  }
  const eventName = asText(ev.name);
  if (!eventName) throw new Error('event.name 必填');
  if (eventName.length > EVENT_NAME_MAX) {
    throw new Error(`event.name 最多 ${EVENT_NAME_MAX} 个字`);
  }

  const status = ev.status === undefined || ev.status === null || ev.status === ''
    ? 'on_sale' : ev.status;
  if (!EVENT_STATUSES.includes(status)) {
    throw new Error(`event.status 只能是 ${EVENT_STATUSES.join(' / ')}`);
  }

  const startsAt = parseEventTime(ev.startsAt, 'event.startsAt');
  const endsAt = parseEventTime(ev.endsAt, 'event.endsAt');
  checkRange(startsAt, endsAt, { start: 'event.startsAt', end: 'event.endsAt' });

  /* ---------- 摊位 ---------- */
  const rawStalls = raw.stalls === undefined ? [] : raw.stalls;
  if (!Array.isArray(rawStalls)) throw new Error('stalls 必须是数组');

  const stalls = rawStalls.map((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw new Error(`stalls[${i}] 必须是一个对象`);
    }
    const name = asText(s.name);
    if (!name) throw new Error(`stalls[${i}].name 必填`);
    if (name.length > STALL_NAME_MAX) {
      throw new Error(`stalls[${i}].name 最多 ${STALL_NAME_MAX} 个字`);
    }
    const loc = s.loc === undefined || s.loc === null ? null : asText(s.loc) || null;
    if (loc && loc.length > STALL_LOC_MAX) {
      throw new Error(`stalls[${i}].loc 最多 ${STALL_LOC_MAX} 个字`);
    }
    return { name, loc };
  });

  // 摊位重名会让「按名字查重」和物品的 stall 引用变得含糊，直接拒绝
  const stallNames = new Set();
  for (const s of stalls) {
    if (stallNames.has(s.name)) throw new Error(`摊位「${s.name}」在配置里出现了两次`);
    stallNames.add(s.name);
  }

  /* ---------- 物品 ---------- */
  const rawItems = raw.items === undefined ? [] : raw.items;
  if (!Array.isArray(rawItems)) throw new Error('items 必须是数组');

  const items = rawItems.map((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      throw new Error(`items[${i}] 必须是一个对象`);
    }
    const name = asText(it.name);
    if (!name) throw new Error(`items[${i}].name 必填`);
    if (name.length > ITEM_NAME_MAX) {
      throw new Error(`items[${i}].name 最多 ${ITEM_NAME_MAX} 个字（和接口的上限一致）`);
    }

    const totalQuota = Number(it.totalQuota);
    if (!Number.isInteger(totalQuota) || totalQuota < 1 || totalQuota > ITEM_QUOTA_MAX) {
      throw new Error(`items[${i}].totalQuota 要是 1–${ITEM_QUOTA_MAX} 的整数`);
    }

    const description = it.description === undefined || it.description === null
      ? null : asText(it.description) || null;
    if (description && description.length > ITEM_DESC_MAX) {
      throw new Error(`items[${i}].description 最多 ${ITEM_DESC_MAX} 个字`);
    }

    const emoji = it.emoji === undefined || it.emoji === null ? null : asText(it.emoji) || null;
    if (emoji && [...emoji].length > ITEM_EMOJI_MAX) {
      throw new Error(`items[${i}].emoji 最多 ${ITEM_EMOJI_MAX} 个字（一个 emoji 算一个）`);
    }

    const tint = it.tint === undefined || it.tint === null || it.tint === ''
      ? ITEM_TINTS[0] : it.tint;
    if (!ITEM_TINTS.includes(tint)) {
      throw new Error(`items[${i}].tint 只能是 ${ITEM_TINTS.join(' / ')}`);
    }

    // 摊位写成**名字**而不是下标：手改 JSON 时挪一行不会把物品挪到别的摊位上
    let stall = null;
    if (it.stall !== undefined && it.stall !== null && it.stall !== '') {
      stall = asText(it.stall);
      if (!stall) throw new Error(`items[${i}].stall 要写成摊位的名字`);
      if (!stallNames.has(stall)) {
        throw new Error(`items[${i}].stall 写的「${stall}」不在 stalls 列表里`);
      }
    }

    // 照片：写**相对配置文件所在目录**的文件名，例如 "photos/曲奇.jpg"。
    // 文件本身在 loadImages() 里读，这里只校验它是个字符串。
    let image = null;
    if (it.image !== undefined && it.image !== null && it.image !== '') {
      image = asText(it.image);
      if (!image) throw new Error(`items[${i}].image 要写成图片文件名`);
    }

    return { name, description, emoji, tint, totalQuota, stall, image };
  });

  const itemNames = new Set();
  for (const it of items) {
    // 物品重名会让「按名字查重」失效：第二次跑就会把同一件东西再加一遍
    if (itemNames.has(it.name)) throw new Error(`物品「${it.name}」在配置里出现了两次`);
    itemNames.add(it.name);
  }

  return {
    event: { name: eventName, status, startsAt, endsAt },
    stalls,
    items,
  };
}

/* ============================================================
   照片：一次性全部读进来验一遍
   ============================================================ */

/**
 * 把配置里引用到的图片**全部读进内存并验一遍**，任何一张有问题就直接抛错。
 *
 * ★ 为什么必须在写库之前全部验完：applyInit 不是一个横跨全程的事务。
 *   如果第 5 件的图有问题才报错，前面 4 件已经建好了 ——
 *   留下一个「建了一半」的库是最难收拾的状态（活动建了、物品缺几件、
 *   而报错信息只说了图片的问题）。
 *
 * 路径是**相对配置文件所在目录**解析的。这样 `cd` 到哪都不影响，
 * 整个活动（配置 + photos/ 目录）可以一起打包搬走。
 */
export function loadImages(config, configDir) {
  const out = new Map();

  for (const it of config.items) {
    if (!it.image || out.has(it.image)) continue;

    const full = path.resolve(configDir, it.image);
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch {
      throw new Error(`物品「${it.name}」的图片读不到：${it.image}（相对配置文件所在目录）`);
    }

    // 用和服务端上传完全同一套判断（validateImage），不另写一份 ——
    // 两边不一致的症状是「界面传得上去，脚本却说不行」
    const v = validateImage(buf);
    if (!v.ok) {
      throw new Error(
        `物品「${it.name}」的图片「${it.image}」用不了：${imageProblemText(v.reason, v.limit)}`
      );
    }

    out.set(it.image, buf);
  }

  return out;
}

/* ============================================================
   计划（只读）
   ============================================================ */

/**
 * 算出「这次会新建什么、会跳过什么」，**不写任何东西**。
 *
 * 复用活动也是按名字：getActiveEvent 只认在售的那一个，如果活动被建成
 * draft 或 ended，它就不认了 —— 只靠它判断的话，同名活动会被再建一遍。
 * 所以这里查的是 listEvents()（全部状态都看得见）。
 */
export function planInit(repo, config) {
  const target = repo.listEvents().find((e) => e.name === config.event.name) || null;

  const active = repo.getActiveEvent();
  const activeConflict = active && (!target || active.id !== target.id)
    ? { id: active.id, name: active.name }
    : null;

  const existingStalls = target ? repo.listStalls(target.id) : [];
  const stallByName = new Map(existingStalls.map((s) => [s.name, s]));

  const stalls = config.stalls.map((s) => {
    const hit = stallByName.get(s.name);
    return hit
      ? { action: 'reuse', name: s.name, id: hit.id, loc: hit.loc }
      : { action: 'create', name: s.name, loc: s.loc };
  });

  const existingItems = target ? repo.listItems(target.id) : [];
  const itemByName = new Map(existingItems.map((i) => [i.name, i]));

  const items = config.items.map((it) => {
    const hit = itemByName.get(it.name);

    // 三种情况：
    //   create —— 库里没有这件东西，建
    //   image  —— 已经建过，但当时没配图，而配置里现在有图 → 只补图
    //   skip   —— 已经建过，不动
    // ★ 补图只在「库里有、但没有图」时发生。已经配过图的**不覆盖** ——
    //   名字对不上（库里存的是服务端生成的随机名），没法判断是不是同一张，
    //   贸然覆盖会把别人在界面上换过的图冲掉。要换图请用管理端的「换图」。
    let action = 'create';
    if (hit) action = (!hit.image && it.image) ? 'image' : 'skip';

    return { action, name: it.name, stall: it.stall, totalQuota: it.totalQuota, image: it.image };
  });

  return {
    event: target
      ? { action: 'reuse', id: target.id, name: target.name, status: target.status }
      : { action: 'create', name: config.event.name, status: config.event.status },
    eventId: target ? target.id : null,
    activeConflict,
    stalls,
    items,
  };
}

/** 把计划渲染成给人看的文本。抽出来是为了能直接测输出里有没有该有的提醒。 */
export function formatPlan(plan, config) {
  const lines = [];

  lines.push(`活动：${plan.event.name}`);
  lines.push(plan.event.action === 'reuse'
    ? `  [复用] 库里已经有同名活动（当前状态 ${plan.event.status}）`
    : `  [新建] 状态 ${plan.event.status}`);

  if (plan.event.action === 'create' && config.event.status !== 'on_sale') {
    lines.push('  [!] 不是 on_sale：小程序看不到它，学生那头会显示「活动还没开始」。');
  }

  // 复用到一个已经不是 on_sale 的活动上，是最容易看漏的一种：脚本会报告
  // 「新建了 N 件物品」，然后小程序里什么都没有。
  if (plan.event.action === 'reuse' && plan.event.status !== 'on_sale') {
    lines.push(`  [!] 复用的这个活动状态是 ${plan.event.status}，不是 on_sale ——`);
    lines.push('      物品会加进去，但小程序看不到它。要用的话先把状态改成 on_sale。');
  }

  lines.push(`摊位（${plan.stalls.length}）：`);
  if (!plan.stalls.length) lines.push('  （没有）');
  for (const s of plan.stalls) {
    const loc = s.loc ? ` — ${s.loc}` : '';
    lines.push(`  [${s.action === 'create' ? '新建' : '复用'}] ${s.name}${loc}`);
  }

  const skip = plan.items.filter((i) => i.action === 'skip').length;
  const fill = plan.items.filter((i) => i.action === 'image').length;
  lines.push(`物品（${plan.items.length}，其中 ${skip} 件已存在会跳过`
    + `${fill ? `、${fill} 件只补图` : ''}）：`);
  if (!plan.items.length) lines.push('  （没有）');
  for (const it of plan.items) {
    const where = it.stall ? `  @ ${it.stall}` : '';
    const pic = it.image ? `  🖼 ${it.image}` : '';
    const tag = { create: '新建', skip: '跳过', image: '补图' }[it.action] || it.action;
    lines.push(`  [${tag}] ${it.name}  ${it.totalQuota} 份${where}${pic}`);
  }

  if (plan.activeConflict) {
    lines.push('');
    lines.push(`[!] 库里当前在售的活动是「${plan.activeConflict.name}」。`);
    if (plan.event.action === 'reuse') {
      lines.push('    它不是配置里的这个 —— 学生打开小程序看到的是上面那个。');
    } else {
      lines.push('    这次会再建一个在售活动；首页只认最新建的那个，旧的不会自动下线。');
    }
  }

  return lines.join('\n');
}

/* ============================================================
   执行（写库）
   ============================================================ */

/**
 * 按配置把数据写进去。可重复运行：已存在的按名字跳过。
 *
 * 顺序必须是活动 → 摊位 → 物品：物品要引用摊位的 id。
 */
export function applyInit(repo, config, { images = new Map(), imageDir = PROD_IMAGE_DIR } = {}) {
  const plan = planInit(repo, config);

  const eventId = plan.event.action === 'create'
    ? repo.createEvent({ ...config.event }).id
    : plan.eventId;

  const stallIdByName = new Map();
  for (const s of plan.stalls) {
    if (s.action === 'reuse') {
      stallIdByName.set(s.name, s.id);
    } else {
      stallIdByName.set(s.name, repo.createStall({ eventId, name: s.name, loc: s.loc }).id);
    }
  }

  /** 把已经验过的图片存进图片目录，拿到服务端生成的文件名 */
  const store = (relPath) => {
    const r = saveImage(images.get(relPath), imageDir);
    if (!r.ok) {
      // loadImages 已经验过一遍，走到这里基本只剩「磁盘满了」这类情况
      throw new Error(`图片「${relPath}」存不下来：${imageProblemText(r.reason, r.limit)}`);
    }
    return r.name;
  };

  const existingByName = new Map(repo.listItems(eventId).map((i) => [i.name, i]));
  const created = [];
  let imagesAdded = 0;

  // 按下标走：plan.items 和 config.items 是同序的（planInit 里就是 map 出来的），
  // 按名字反查既慢又要依赖「名字唯一」这个前提。
  config.items.forEach((it, i) => {
    const { action } = plan.items[i];
    if (action === 'skip') return;

    if (action === 'image') {
      repo.updateItem({ itemId: existingByName.get(it.name).id, image: store(it.image) });
      imagesAdded += 1;
      return;
    }

    created.push(repo.createItem({
      eventId,
      stallId: it.stall ? stallIdByName.get(it.stall) : null,
      name: it.name,
      description: it.description,
      emoji: it.emoji,
      tint: it.tint,
      image: it.image ? store(it.image) : null,
      totalQuota: it.totalQuota,
      status: 'on_sale',
    }));
  });

  const stallsCreated = plan.stalls.filter((s) => s.action === 'create').length;
  const itemsSkipped = plan.items.filter((i) => i.action === 'skip').length;

  // 和接口里的操作日志同一个去处。actorId 为 null = 服务端脚本做的，
  // 事后有人问「这活动谁建的」时查得到。
  repo.writeAudit({
    actorId: null, action: 'event.init',
    targetType: 'event', targetId: eventId,
    detail: {
      via: 'scripts/init-event.mjs',
      event: plan.event.action,
      stallsCreated,
      itemsCreated: created.length,
      itemsSkipped,
      imagesAdded,
    },
  });

  return {
    eventId, eventAction: plan.event.action, stallsCreated, itemsCreated: created.length,
    itemsSkipped, imagesAdded, created,
  };
}

/* ============================================================
   CLI
   ============================================================ */

export function parseArgs(argv) {
  const args = { file: '', yes: false, help: false };
  for (const a of argv) {
    if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('-')) throw new Error(`不认识的参数：${a}`);
    else if (!args.file) args.file = a;
    else throw new Error(`多余的参数：${a}（只接受一个配置文件）`);
  }
  return args;
}

/**
 * 脚本主体。返回退出码，不自己 process.exit。
 *
 * 抽成导出函数是为了能直接测**「不加 --yes 时一个字节都不写」**这条安全属性。
 * 沙箱里起不了子进程，靠 `node scripts/init-event.mjs` 是测不了它的。
 */
export function run({ argv = [], env = {}, out = console.log, err = console.error } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`[x] ${e.message}\n\n${USAGE}`);
    return 1;
  }

  if (args.help || !args.file) {
    out(USAGE);
    return args.help ? 0 : 1;
  }

  const dbPath = env.DB_PATH || PROD_DB_PATH;
  const imageDir = env.IMAGE_DIR || PROD_IMAGE_DIR;

  let config;
  try {
    config = parseConfig(JSON.parse(fs.readFileSync(args.file, 'utf8')));
  } catch (e) {
    if (e && e.code === 'ENOENT') err(`[x] 找不到配置文件：${args.file}`);
    else if (e instanceof SyntaxError) err(`[x] ${args.file} 不是合法的 JSON：${e.message}`);
    else err(`[x] 配置有问题：${e.message}`);
    return 1;
  }

  // 照片在这一步全部读进来验完 —— 必须在碰数据库之前。
  // 否则第 5 件的图有问题时，前 4 件已经建好了。
  let images;
  try {
    images = loadImages(config, path.dirname(path.resolve(args.file)));
  } catch (e) {
    err(`[x] ${e.message}`);
    return 1;
  }

  // ★ 只看计划时，如果库文件还不存在，就用一个**内存库**来算。
  //   openMigrated 会建目录、建文件、跑一遍建表语句 —— 光是「看一眼会建什么」
  //   就凭空造出一个空的库文件来，跑错路径时那个文件还会留在那儿，
  //   下次看就像"已经初始化过了"。
  const planOnly = !args.yes;
  const useMemory = planOnly && !fs.existsSync(dbPath);
  const db = openMigrated(useMemory ? ':memory:' : dbPath);
  const repo = createSqliteRepository(db);

  try {
    const plan = planInit(repo, config);

    // 目标库打在计划之前 —— 这是整个脚本里最该被看见的一行。
    // 「我在本地跑了一下怎么线上没变」和「我以为是本地结果写了线上」
    // 这两种事故，都是因为没看清这个路径。
    out(`目标库：${dbPath}${useMemory ? '（还没有这个库）' : ''}`);
    if (images.size) out(`照片：  ${imageDir}（本次涉及 ${images.size} 张）`);
    out(`配置：  ${args.file}\n`);
    out(formatPlan(plan, config));

    if (!args.yes) {
      out('\n这是只读的计划，**没有写库**。确认无误后加 --yes 再跑一次：');
      out(`  node scripts/init-event.mjs ${args.file} --yes`);
      return 0;
    }

    const r = applyInit(repo, config, { images, imageDir });
    out(`\n✅ 已写入库：活动「${config.event.name}」（${r.eventAction === 'create' ? '新建' : '复用'}）`);
    out(`   新建摊位 ${r.stallsCreated} 个 / 新建物品 ${r.itemsCreated} 件`
      + ` / 补图 ${r.imagesAdded} 件 / 跳过已存在 ${r.itemsSkipped} 件`);
    out('   小程序里下拉刷新就能看到了。');
    return 0;
  } finally {
    db.close();
  }
}

function main() {
  process.exitCode = run({ argv: process.argv.slice(2), env: process.env });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
