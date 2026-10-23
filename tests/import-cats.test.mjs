/**
 * 导入脚本的映射逻辑（纯函数）。
 *
 * 真正跑导入要读那堆 300MB 的素材目录，不能进测试；但「怎么映射、怎么去重、
 * 哪些是垃圾数据」这些判断是最容易出错的部分，必须钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isJunk, tintOf, mapRecord, mergeSnapshots, STATUS_MAP, runImport, attachImages,
} from '../scripts/import-cats.mjs';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';

test('导入：测试数据要滤掉（「张三李四」不该进图鉴）', () => {
  for (const name of ['在校参考猫', '喵星参考猫', '1111', '1', '张三李四', '超级全能全数据猫咪']) {
    assert.equal(isJunk({ name }), true, `${name} 应该被当成垃圾数据`);
  }
  for (const name of ['中玳瑁', '八嘎猫', '重型橘猫', '小黑']) {
    assert.equal(isJunk({ name }), false, `${name} 是真猫`);
  }
});

test('导入：状态映射覆盖旧数据的全部取值', () => {
  // 旧数据的 status 只有这四种（实测 46 条里就是这个分布）
  for (const old of ['健康', '送养', '失踪', '离世']) {
    assert.ok(STATUS_MAP[old], `旧状态「${old}」没有映射`);
  }
  assert.equal(mapRecord({ name: '猫', status: '送养' }).status, 'adopted');
  assert.equal(mapRecord({ name: '猫', status: '失踪' }).status, 'missing');
  assert.equal(mapRecord({ name: '猫', status: '离世' }).status, 'passed');
  // 认不出来时不丢猫 —— 落到「在校」，让人能看见并手动改
  assert.equal(mapRecord({ name: '猫', status: '无法判断的怪值' }).status, 'onCampus');
});

test('导入：品种推底色（列表页没照片时靠它上色）', () => {
  assert.equal(tintOf('狸花'), 't-green');
  assert.equal(tintOf('橘猫及橘白'), 't-yellow');
  assert.equal(tintOf('玳瑁及三花'), 't-purple');
  assert.equal(tintOf('奶牛'), 't-blue');
  assert.equal(tintOf(''), 't-pink', '认不出来要有默认色，不能留空');
});

test('导入：一条记录映射到我们的字段，空值给 null 而不是空串', () => {
  const rec = {
    name: ' 中玳瑁 ', gender: '母', status: '健康', character: '亲人不可抱可摸',
    moreInformation: '', location: '多功能', classification: '玳瑁及三花',
    furColor: '橙黑错杂', isSterilization: '未绝育', campus: '盛乐校区',
    nickName: '颠颠', appearance_overall: '阴阳脸', firstSightingTime: '2023-11-01',
    relationship: '和玳瑁妈妈是母子', relatedCats: '小黑 胆小橘', birthTime: '2022-08-06',
    friendliness: '温和',
  };
  const out = mapRecord(rec);

  assert.equal(out.name, '中玳瑁', '名字要 trim');
  assert.equal(out.gender, '母');
  assert.equal(out.status, 'onCampus');
  assert.equal(out.personality, '亲人不可抱可摸', 'character → personality');
  assert.equal(out.note, null, '空的简介给 null，不是空串');
  assert.equal(out.nickName, '颠颠');
  assert.equal(out.appearance, '阴阳脸', 'appearance_overall → appearance');
  assert.equal(out.sterilized, '未绝育');
  assert.equal(out.relatedCats, '小黑 胆小橘');
  assert.equal(out.emoji, '🐈');
});

test('导入：性别只认公/母，其余一律未知', () => {
  assert.equal(mapRecord({ name: '猫', gender: '公' }).gender, '公');
  assert.equal(mapRecord({ name: '猫', gender: '母' }).gender, '母');
  for (const g of ['', undefined, null, '未知', '未记录']) {
    assert.equal(mapRecord({ name: '猫', gender: g }).gender, '未知', `性别「${g}」应落到未知`);
  }
});

test('导入：多份快照按名字合并，取最后编辑时间最新的那条', () => {
  const older = {
    name: '八嘎猫', status: '健康', location: '东门',
    lastEditTime: 'Mon Jul 03 2023 21:34:34 GMT+0800 (中国标准时间)',
  };
  const newer = {
    name: '八嘎猫', status: '失踪', location: '西十四',
    lastEditTime: 'Sun Jun 15 2025 15:32:53 GMT+0800 (中国标准时间)',
  };
  const other = { name: '小黑', status: '健康', lastEditTime: 'Sun Jun 15 2025 15:32:53 GMT+0800 (中国标准时间)' };

  const merged = mergeSnapshots([older, newer, other]);
  assert.equal(merged.length, 2, '同名只留一条');
  const ba = merged.find((c) => c.name === '八嘎猫');
  assert.equal(ba.location, '西十四', '要取最新那条（旧的那条是过期的）');
});

test('导入：合并时顺手丢掉垃圾数据和没有名字的记录', () => {
  const merged = mergeSnapshots([
    { name: '真猫', status: '健康', lastEditTime: 'Sun Jun 15 2025 15:32:53 GMT+0800 (中国标准时间)' },
    { name: '张三李四', status: '健康', lastEditTime: 'Sun Jun 15 2025 15:32:53 GMT+0800 (中国标准时间)' },
    { name: '', status: '健康', lastEditTime: 'Sun Jun 15 2025 15:32:53 GMT+0800 (中国标准时间)' },
    null,
  ]);
  assert.deepEqual(merged.map((c) => c.name), ['真猫']);
});

/* ============================================================
   整条流水线：假导出目录 → 拷贝图片 → 落库 → 再跑一次要跳过
   ============================================================ */

/** 一段最小的「合法 JPEG」：服务端看魔术字节，够了 */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0)]);

function makeExport() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-import-'));
  const data = path.join(root, '导出');
  const catDir = path.join(data, 'Cat_1');
  fs.mkdirSync(path.join(data, '1.数据'), { recursive: true });
  fs.mkdirSync(catDir, { recursive: true });

  const t = 'Sun Jun 15 2025 15:32:53 GMT+0800 (中国标准时间)';
  const lines = [
    { name: '中玳瑁', gender: '母', status: '健康', character: '亲人', moreInformation: '颠颠',
      classification: '玳瑁及三花', furColor: '橙黑', campus: '盛乐校区', lastEditTime: t },
    { name: '嗓门哥', gender: '公', status: '送养', character: '嗓门大', classification: '狸花',
      lastEditTime: t },
    { name: '张三李四', status: '健康', lastEditTime: t },   // 垃圾数据，要被滤掉
  ];
  fs.writeFileSync(path.join(data, '1.数据', 'export.json'),
    lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');

  fs.writeFileSync(path.join(catDir, '封面-中玳瑁.jpg'), JPEG);
  fs.writeFileSync(path.join(catDir, '在校照片-中玳瑁-1.jpg'), JPEG);
  fs.writeFileSync(path.join(catDir, '在校照片-中玳瑁-2.jpg'), JPEG);
  // 嗓门哥的封面故意做成超限（>2MB），验证「跳过而不是整只丢掉」
  const big = Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024, 0)]);
  fs.writeFileSync(path.join(catDir, '封面-嗓门哥.jpg'), big);

  return { root, data, dbPath: path.join(root, 'test.db'), imageDir: path.join(root, 'images') };
}

test('导入：整条流水线能跑通，图片真的落盘，超限的图跳过不影响那只猫', () => {
  const env = makeExport();
  try {
    const r = runImport({ dataDir: env.data, dbPath: env.dbPath, imageDir: env.imageDir, yes: true, log: () => {} });

    assert.equal(r.imported, 2, '两只真猫都要导进去（垃圾数据不算）');
    assert.equal(r.covers, 1, '只有一张合格封面');
    assert.equal(r.photos, 2, '两张在校照片进相册');
    assert.equal(r.oversize.length, 1, '超限的封面要被记下来');
    assert.match(r.oversize[0], /嗓门哥/);

    // 图片真的落盘了
    const files = fs.readdirSync(env.imageDir);
    assert.equal(files.length, 3, `图片目录里应有 3 张，实际 ${files.join(',')}`);

    // 落库检查：补充资料、状态映射、相册都在
    const db = openMigrated(env.dbPath);
    const repo = createSqliteRepository(db);
    try {
      const cats = repo.listCats();
      assert.deepEqual(cats.map((c) => c.name).sort(), ['中玳瑁', '嗓门哥'].sort());

      const zhong = cats.find((c) => c.name === '中玳瑁');
      assert.equal(zhong.campus, '盛乐校区');
      assert.equal(zhong.furColor, '橙黑');
      assert.equal(zhong.note, '颠颠');
      assert.deepEqual(repo.listCatImages(zhong.id).map((x) => x.image).length, 2);

      const sang = cats.find((c) => c.name === '嗓门哥');
      assert.equal(sang.status, 'adopted', '送养要映射成已送养');
      assert.equal(sang.image, null, '封面超限 → 主图为空，但猫仍然导入');
      assert.deepEqual(repo.listCatImages(sang.id), []);
    } finally { db.close(); }
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('导入：再跑一次不会重复导入（线上可能已经导过一次）', () => {
  const env = makeExport();
  try {
    assert.equal(runImport({ dataDir: env.data, dbPath: env.dbPath, imageDir: env.imageDir, yes: true, log: () => {} }).imported, 2);

    const second = runImport({ dataDir: env.data, dbPath: env.dbPath, imageDir: env.imageDir, yes: true, log: () => {} });
    assert.equal(second.imported, 0, '同名已存在就跳过');
    assert.equal(second.skippedExisting, 2);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('导入：演练模式不建库、不建图片目录', () => {
  const env = makeExport();
  try {
    const r = runImport({ dataDir: env.data, dbPath: env.dbPath, imageDir: env.imageDir, yes: false, log: () => {} });
    assert.equal(r.planned, 2);
    assert.equal(fs.existsSync(env.dbPath), false, '演练模式不该顺手建出一个空库');
    assert.equal(fs.existsSync(env.imageDir), false, '演练模式不该建图片目录');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

/* ============================================================
   补图模式（--attach）：给已经导过的猫补封面 / 相册
   ============================================================ */

/** 造一个「库里已有猫」的环境：一只猫 + 相册里已有一张图 */
function makeAttachEnv() {
  const env = makeExport();
  runImport({ dataDir: env.data, dbPath: env.dbPath, imageDir: env.imageDir, yes: true, log: () => {} });

  const attachDir = path.join(env.root, '补图');
  fs.mkdirSync(attachDir, { recursive: true });
  return { ...env, attachDir };
}

test('补图：封面和相册都能补进去，内容重复的自动跳过', () => {
  const env = makeAttachEnv();
  try {
    const db = openMigrated(env.dbPath);
    const repo = createSqliteRepository(db);
    const zhong = repo.listCats().find((c) => c.name === '中玳瑁');
    // 中玳瑁导入时是有封面的，先把它清掉，模拟「封面被跳过」的那几只
    repo.updateCat(zhong.id, { image: null });
    const before = repo.listCatImages(zhong.id).map((x) => x.image);
    assert.equal(before.length, 2, '前提：相册里已有 2 张');
    db.close();

    // 补图目录：一张新封面、一张新相册图、一张与已有相册**同内容**的图
    const newCover = Buffer.concat([JPEG, Buffer.from('cover')]);
    const newPhoto = Buffer.concat([JPEG, Buffer.from('photo-new')]);
    fs.writeFileSync(path.join(env.attachDir, '封面-中玳瑁.jpg'), newCover);
    fs.writeFileSync(path.join(env.attachDir, '在校照片-中玳瑁-3.jpg'), newPhoto);
    // 与相册里已有的第一张同内容（导出时同一张图被写了两份）
    const existingFirst = fs.readFileSync(path.join(env.imageDir, before[0]));
    fs.writeFileSync(path.join(env.attachDir, '在校照片-中玳瑁-9.jpg'), existingFirst);

    const r = attachImages({
      dir: env.attachDir, dbPath: env.dbPath, imageDir: env.imageDir, log: () => {},
    });

    assert.equal(r.covers, 1);
    assert.equal(r.photos, 1, '同内容那张要被哈希判重跳过，只该补进 1 张');

    const db2 = openMigrated(env.dbPath);
    const repo2 = createSqliteRepository(db2);
    try {
      const cat = repo2.listCats().find((c) => c.name === '中玳瑁');
      assert.ok(cat.image, '封面补上了');
      const gallery = repo2.listCatImages(cat.id).map((x) => x.image);
      assert.equal(gallery.length, 3, '2 张原有 + 1 张新补');
      assert.deepEqual(gallery.slice(0, 2), before, '原有的顺序不能被打乱（是展示顺序）');
    } finally { db2.close(); }
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('补图：可以重复跑，第二次什么都不加', () => {
  const env = makeAttachEnv();
  try {
    fs.writeFileSync(path.join(env.attachDir, '封面-中玳瑁.jpg'), Buffer.concat([JPEG, Buffer.from('c2')]));
    fs.writeFileSync(path.join(env.attachDir, '在校照片-中玳瑁-5.jpg'), Buffer.concat([JPEG, Buffer.from('p5')]));

    const args = { dir: env.attachDir, dbPath: env.dbPath, imageDir: env.imageDir, log: () => {} };
    assert.equal(attachImages(args).covers, 1);
    const second = attachImages(args);
    assert.equal(second.covers, 0, '同一张封面不该重复落盘');
    assert.equal(second.photos, 0, '同一张相册图不该重复追加');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('补图：库里没有的猫要报告出来，不能静默丢掉', () => {
  const env = makeAttachEnv();
  try {
    fs.writeFileSync(path.join(env.attachDir, '封面-不存在的猫.jpg'), JPEG);
    const r = attachImages({ dir: env.attachDir, dbPath: env.dbPath, imageDir: env.imageDir, log: () => {} });
    assert.deepEqual(r.unknown, ['不存在的猫']);
    assert.equal(r.covers, 0);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
