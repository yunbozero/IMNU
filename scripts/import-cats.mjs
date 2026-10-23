/**
 * 把上一届图鉴的数据导进来。
 *
 * 数据来源（都在那个导出目录里）：
 *   `4.素材数据` 下的 1.数据 目录里的 JSON 文件   7 份 JSONL 快照，每份 42–46 条
 *   `Cat_xxx/封面-<猫名>.jpg`                    每只猫一张主图
 *   `Cat_xxx/在校照片-<猫名>-<n>.jpg`             相册（每只 1–5 张）
 *
 * 三条设计：
 *   1. **按猫名去重、取 lastEditTime 最新的那条** —— 那 7 份是不同时间点的快照，
 *      不是 7 批不同的猫；不合并会导进一堆重复。
 *   2. **同名已存在就跳过**，绝不覆盖 —— 线上可能已经有管理员手加的猫，
 *      而且这脚本会被跑第二次。
 *   3. **提前打印要做什么，默认不写库**（`--yes` 才真写）。和 init-event.mjs 同一个规矩。
 *
 * 用法：
 *   node scripts/import-cats.mjs --data <导出目录> [--db <库路径>] [--images <图片目录>] [--yes]
 *
 *   --data    含 JSONL 的目录（会递归找 *.json）
 *   --db      目标库，默认和 set-owner 一样取 DEV 库（线上要显式传）
 *   --images  目标图片目录，默认跟着 db 走（DEV_IMAGE_DIR / PROD_IMAGE_DIR）
 *   --yes     真的写库
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { openMigrated, DEV_DB_PATH, PROD_DB_PATH } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import { saveImage, MAX_IMAGE_BYTES, DEV_IMAGE_DIR, PROD_IMAGE_DIR } from '../server/images.mjs';
import { CAT_IMAGES_MAX } from '../server/api.mjs';

/* ============================================================
   纯逻辑部分（不碰文件、不碰库）—— tests/import-cats.test.mjs 直接测它
   ============================================================ */

/** 明显不是猫的测试数据。宁可少导，也别把「张三李四」导进图鉴。 */
const JUNK_NAME = /^(1111|1|张三李四|超级全能全数据猫咪)$|参考猫|测试/;

export function isJunk(rec) {
  return JUNK_NAME.test(String(rec && rec.name || '').trim());
}

/** 旧 status → 我们的 status 键。认不出来的落到在校。 */
export const STATUS_MAP = {
  健康: 'onCampus',
  在校: 'onCampus',
  失踪: 'missing',
  离世: 'passed',
  送养: 'adopted',
};

/** 品种 → 底色。没匹配上的给 t-pink（和界面里的默认色一致）。 */
const TINT_BY_CLASS = [
  [/狸花|虎斑/, 't-green'],
  [/橘/, 't-yellow'],
  [/玳瑁|三花/, 't-purple'],
  [/奶牛/, 't-blue'],
  [/纯色|黑|白/, 't-pink'],
];

export function tintOf(classification) {
  const s = String(classification || '');
  for (const [re, tint] of TINT_BY_CLASS) if (re.test(s)) return tint;
  return 't-pink';
}

const text = (v) => {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s || null;
};

/**
 * 一条旧记录 → 我们的 cats 入参。**只映射有值的字段**，
 * 空的一律 null（不是空串），这样库里看得出「没有这项资料」。
 */
export function mapRecord(rec) {
  const genderRaw = text(rec.gender);
  const gender = ['公', '母'].includes(genderRaw) ? genderRaw : '未知';

  return {
    name: text(rec.name),
    emoji: '🐈',
    tint: tintOf(rec.classification),
    status: STATUS_MAP[text(rec.status)] || 'onCampus',
    gender,
    location: text(rec.location),
    personality: text(rec.character),
    note: text(rec.moreInformation),
    // 补充资料
    nickName: text(rec.nickName),
    campus: text(rec.campus),
    classification: text(rec.classification),
    furColor: text(rec.furColor),
    friendliness: text(rec.friendliness),
    sterilized: text(rec.isSterilization),
    appearance: text(rec.appearance_overall),
    firstSightingAt: text(rec.firstSightingTime),
    firstSightingLoc: text(rec.firstSightingLocation),
    relationship: text(rec.relationship),
    relatedCats: text(rec.relatedCats),
    birthAt: text(rec.birthTime),
    deathAt: text(rec.deathTime),
    deathReason: text(rec.deathReason),
    missingAt: text(rec.missingTime),
    deliveryAt: text(rec.deliveryTime),
  };
}

/**
 * 多份快照合并成「一只猫一条」：按名字去重，取 lastEditTime 最新的。
 * 顺手丢掉测试数据，并按名字排序（让输出可预期、好对照）。
 */
export function mergeSnapshots(records) {
  const byName = new Map();
  for (const rec of records) {
    if (!rec || isJunk(rec)) continue;
    const name = text(rec.name);
    if (!name) continue;
    const t = Date.parse(rec.lastEditTime) || 0;
    const prev = byName.get(name);
    if (!prev || t > prev.t) byName.set(name, { t, rec });
  }
  return [...byName.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'zh'))
    .map(([, v]) => v.rec);
}

/* ============================================================
   IO 部分
   ============================================================ */

function parseArgs(argv) {
  const out = { data: '', db: '', images: '', attach: '', yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') out.yes = true;
    else if (a === '--data') out.data = argv[++i];
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--images') out.images = argv[++i];
    else if (a === '--attach') out.attach = argv[++i];
  }
  return out;
}

function readAllJsonl(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.toLowerCase().endsWith('.json')) files.push(f);
    }
  };
  walk(dir);

  const out = [];
  const bad = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    for (const [i, line] of lines.entries()) {
      try { out.push(JSON.parse(line)); } catch { bad.push(`${path.basename(f)}:${i + 1}`); }
    }
  }
  return { out, files: files.length, bad };
}

/** 按文件名把封面 / 在校照片分组：{ name: { cover, photos: [{index, file}] } } */
function indexImages(dir) {
  const map = new Map();
  const ensure = (name) => {
    if (!map.has(name)) map.set(name, { cover: null, photos: [] });
    return map.get(name);
  };

  for (const f of fs.readdirSync(dir)) {
    let m = /^封面-(.+)\.(jpg|jpeg|png|webp)$/i.exec(f);
    if (m) { ensure(m[1]).cover = f; continue; }
    m = /^在校照片-(.+)-(\d+)\.(jpg|jpeg|png|webp)$/i.exec(f);
    if (m) { ensure(m[1]).photos.push({ index: Number(m[2]), file: f }); }
  }

  for (const entry of map.values()) entry.photos.sort((a, b) => a.index - b.index);
  return map;
}

/** 把一张图搬进图片目录并返回服务端文件名；太大 / 不是图片就跳过。 */
function importImage(file, imageDir, skipped) {
  const buf = fs.readFileSync(file);
  if (buf.length > MAX_IMAGE_BYTES) {
    skipped.push(`${path.basename(file)}（${(buf.length / 1024 / 1024).toFixed(1)}MB，超过 2MB）`);
    return null;
  }
  const r = saveImage(buf, imageDir);
  if (!r.ok) {
    skipped.push(`${path.basename(file)}（${r.reason}）`);
    return null;
  }
  return r.name;
}

/** 图片内容的 md5。用来判重 —— 服务端会把文件改名，只能按字节比。 */
const hashOf = (buf) => createHash('md5').update(buf).digest('hex');

/**
 * 给**已经导过**的猫补图（主图 / 相册）。
 *
 * 为什么需要单独一条路：主导入是「同名跳过」，所以第一次因为超过 2MB 被跳过的图，
 * 压小之后再跑主导入也补不进去 —— 猫已经在了。
 *
 * 幂等靠**内容哈希**：图片目录里已有的文件先算一遍 md5，新图内容相同就跳过。
 * 这样这个命令可以放心跑第二遍，不会把同一张照片塞进相册两次
 * （服务端存的是 img_<随机>.<ext>，文件名对不上，只能按字节判）。
 */
export function attachImages({ dir, dbPath, imageDir, log = console.log } = {}) {
  const db = openMigrated(dbPath);
  const repo = createSqliteRepository(db);

  try {
    const byName = new Map(repo.listCats().map((c) => [c.name, c]));
    const known = new Set();
    for (const f of fs.readdirSync(imageDir)) {
      try { known.add(hashOf(fs.readFileSync(path.join(imageDir, f)))); } catch { /* 读不到就算了 */ }
    }

    const wanted = indexImages(dir);
    const skippedOversize = [];
    const unknown = [];
    const duplicates = [];
    let covers = 0;
    let photos = 0;

    for (const [name, media] of wanted) {
      const cat = byName.get(name);
      if (!cat) { unknown.push(name); continue; }

      // 封面：有就换。旧封面如果是兜底用的相册第一张，那张还留在相册里，不会成为孤儿。
      // 内容相同的（比如上一次补图已经换过）直接跳过，不重复落盘。
      if (media.cover) {
        const coverFile = path.join(dir, media.cover);
        let coverBuf = null;
        try { coverBuf = fs.readFileSync(coverFile); } catch { /* 读不到就当没有 */ }
        if (coverBuf && !known.has(hashOf(coverBuf))) {
          const saved = importImage(coverFile, imageDir, skippedOversize);
          if (saved) {
            known.add(hashOf(coverBuf));
            repo.updateCat(cat.id, { image: saved });
            covers += 1;
          }
        } else if (coverBuf) {
          // 封面和某张已存在的图同内容（很常见：封面就是相册里的第一张）
          duplicates.push(`${media.cover}（与已有图片相同）`);
        }
      }

      // 相册：只追加内容没见过的，且总数不超过上限
      const Have = repo.listCatImages(cat.id).map((x) => x.image);
      const added = [];
      for (const ph of media.photos) {
        if (Have.length + added.length >= CAT_IMAGES_MAX) break;
        const file = path.join(dir, ph.file);
        let buf;
        try { buf = fs.readFileSync(file); } catch { continue; }
        const h = hashOf(buf);
        if (known.has(h)) {
          // 同内容的图跳过 —— 但要说出来，否则「怎么少了两张」没人查得动
          duplicates.push(`${ph.file}（与已有图片相同）`);
          continue;
        }
        const saved = importImage(file, imageDir, skippedOversize);
        if (!saved) continue;
        known.add(h);
        added.push(saved);
      }
      if (added.length) {
        repo.setCatImages(cat.id, [...Have, ...added]);
        photos += added.length;
      }
    }

    log(`\n补图完成：${covers} 张主图、${photos} 张相册`);
    if (duplicates.length) {
      log(`ℹ️ ${duplicates.length} 张与已有图片内容完全相同，已跳过（不是失败）：`);
      for (const d of duplicates) log('   · ' + d);
      log('   常见原因：封面本来就用的是某张相册照片；或者老数据里同一张图被挂到了两只猫上。');
    }
    if (unknown.length) log(`⚠️ 有 ${unknown.length} 组图在库里找不到同名猫，已跳过：${unknown.join('、')}`);
    if (skippedOversize.length) {
      log(`⚠️ ${skippedOversize.length} 张仍有问题：`);
      for (const s of skippedOversize) log('   · ' + s);
    }
    log(`库：${dbPath}`);

    return { covers, photos, unknown, duplicates, oversize: skippedOversize };
  } finally {
    db.close();
  }
}

/**
 * 真正干活的那一层：抽成可调用的函数，测试才能拿一个假导出目录跑完整流程
 * （否则只能测映射，测不到「拷图 + 落库 + 第二次跑要跳过」）。
 *
 * @returns {{planned:number, imported:number, skippedExisting:number,
 *            covers:number, photos:number, oversize:string[]}}
 */
export function runImport({ dataDir, dbPath, imageDir, yes = false, log = console.log } = {}) {
  const { out: records, files, bad } = readAllJsonl(dataDir);
  const merged = mergeSnapshots(records);
  log(`读到 ${files} 份快照、${records.length} 条记录；按名字去重后 ${merged.length} 只猫`);
  if (bad.length) log(`  ⚠️ 有 ${bad.length} 行不是合法 JSON，已跳过：${bad.slice(0, 5).join('、')}`);

  // 图片目录：dataDir 下找含「封面-」的子目录
  const imgDirs = fs.readdirSync(dataDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dataDir, e.name))
    .filter((d) => fs.readdirSync(d).some((f) => /^封面-/.test(f)));
  if (!imgDirs.length) log('  ⚠️ 没找到含「封面-」的图片目录，本次只导资料、不带照片');
  const byName = imgDirs.length ? indexImages(imgDirs[0]) : new Map();

  // ★ 演练模式**不连库、不建目录**：只想看一眼的时候，不该顺手在工作区里
  //   建出一个空库和一个 Images 目录。所以「已存在跳过」只有真导时才算。
  if (!yes) {
    log(`\n计划导入 ${merged.length} 只（演练模式，未连库，所以没算「已存在」的）：`);
    for (const [i, rec] of merged.entries()) {
      const f = mapRecord(rec);
      const media = byName.get(f.name) || { cover: null, photos: [] };
      const n = media.photos.length;
      log(`  ${String(i + 1).padStart(2)}. ${f.name.padEnd(10)} ${f.status.padEnd(9)}`
        + ` 封面${media.cover ? '✓' : '✗'} 相册${n ? n + ' 张' : '—'}`);
    }
    log('\n（演练模式：没有写库。确认无误后加 --yes 重跑）');
    log(`目标库：${dbPath}`);
    log(`图片目录：${imageDir}`);
    return { planned: merged.length, imported: 0, skippedExisting: 0, covers: 0, photos: 0, oversize: [] };
  }

  fs.mkdirSync(imageDir, { recursive: true });
  const db = openMigrated(dbPath);
  const repo = createSqliteRepository(db);

  const existing = new Set(repo.listCats().map((c) => c.name));
  const plan = [];
  const oversize = [];
  let alreadyThere = 0;

  for (const rec of merged) {
    const fields = mapRecord(rec);
    if (existing.has(fields.name)) { alreadyThere += 1; continue; }
    const media = byName.get(fields.name) || { cover: null, photos: [] };
    plan.push({ fields, media });
  }

  log(`\n导入 ${plan.length} 只（已存在跳过 ${alreadyThere} 只）`);

  let cats = 0;
  let covers = 0;
  let photos = 0;
  try {
    for (const p of plan) {
      const media = p.media;

      // 相册：先搬图，最多 9 张（服务端上限），单张超 2MB 就跳过
      const gallery = [];
      for (const ph of media.photos.slice(0, 9)) {
        const name = importImage(path.join(imgDirs[0], ph.file), imageDir, oversize);
        if (name) gallery.push(name);
      }

      // 主图：没封面就退回相册第一张，免得列表页是一片 emoji
      let cover = null;
      if (media.cover) cover = importImage(path.join(imgDirs[0], media.cover), imageDir, oversize);
      if (!cover && gallery.length) cover = gallery[0];

      const r = repo.createCat({ ...p.fields, image: cover });
      if (!r.ok) { log(`  ✗ ${p.fields.name}: ${r.reason}`); continue; }
      if (gallery.length) repo.setCatImages(r.cat.id, gallery);

      cats += 1;
      if (cover) covers += 1;
      photos += gallery.length;
    }

    log(`\n✅ 导入完成：${cats} 只猫（${covers} 张主图、${photos} 张相册）`);
    if (oversize.length) {
      log(`⚠️ ${oversize.length} 张图被跳过（超过 2MB 或不是有效图片）：`);
      for (const s of oversize) log('   · ' + s);
      log('   这些可以在管理端手动补图（小程序上传时会自动压缩）。');
    }
    log(`库：${dbPath}`);
  } finally {
    db.close();
  }

  return {
    planned: merged.length,
    imported: cats,
    skippedExisting: alreadyThere,
    covers,
    photos,
    oversize,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // 默认落 DEV 库：和 set-owner / seed-dev 一致，避免「只想试一下」却写进线上库。
  // 线上必须显式传 --db，和 docs 里的运维口径一致。
  const dbPath = args.db || DEV_DB_PATH;
  const imageDir = args.images || (args.db === PROD_DB_PATH ? PROD_IMAGE_DIR : DEV_IMAGE_DIR);

  // 补图模式：只处理「库里已经有这只猫」的情况（压小过的图从这里补进去）
  if (args.attach) {
    attachImages({ dir: args.attach, dbPath, imageDir });
    return;
  }

  if (!args.data) {
    console.error(
      '用法：\n'
      + '  导入：node scripts/import-cats.mjs --data <含 JSONL 的目录> [--db 库] [--images 目录] [--yes]\n'
      + '  补图：node scripts/import-cats.mjs --attach <图片目录> [--db 库] [--images 目录]',
    );
    process.exit(1);
  }

  runImport({ dataDir: args.data, dbPath, imageDir, yes: args.yes });
}

// ★ 用 pathToFileURL 而不是拼 `file://`：路径里有 # 或 % 时拼出来的 URL 不等价，
//   脚本会静默地不执行 main（这个坑在别的脚本里也踩过）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
