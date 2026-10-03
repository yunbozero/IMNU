/**
 * 数据库迁移。
 *
 * 这是本项目第一次改表结构，而 `migrate()` 原本只是把
 * `CREATE TABLE IF NOT EXISTS ...` 重跑一遍 —— 对**已经存在**的表它什么都不做。
 * 所以「给 items 加 image 列」这件事对老库是无效的，必须显式 ALTER。
 *
 * 这里测的就是那条路径：拿一个**没有 image 列的、装着真实数据的库**，
 * 跑一次 migrate，列要出现、数据要一条不少。
 * 线上库里已经有真实预定了，这一步搞错的代价比改代码大得多。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMigrated, openDatabase, migrate, SCHEMA } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';

/**
 * 迁移前的 items 建表语句：把当前 SCHEMA 里那一行 image 去掉。
 *
 * ★ 那个逗号不能省。cat_photos 表里也有一列叫 image（写成 `TEXT NOT NULL,`），
 *   不写逗号的话这条自检会指着**另一张表**报错 —— 明明 items 那边删对了，
 *   报的却是「删完之后不该还留着 image 列」，方向完全错。
 */
const IMAGE_COL_LINE = /^[ \t]*image[ \t]+TEXT,[^\n]*\n/m;

function schemaWithoutImage() {
  const old = SCHEMA.replace(IMAGE_COL_LINE, '');
  assert.notEqual(old, SCHEMA, '没能从 SCHEMA 里删掉 image 那一行，这个测试就没意义了');
  assert.ok(!IMAGE_COL_LINE.test(old), '删完之后 items 里不该还留着 image 列');
  return old;
}

/** 直接读列名，不走 migrate 里那个内部函数 */
const columnsOf = (db, table) =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);

test('迁移：全新的库建出来就带 image 列', () => {
  const db = openMigrated(':memory:');
  try {
    assert.ok(columnsOf(db, 'items').includes('image'), 'SCHEMA 里应当有 image 列');
  } finally { db.close(); }
});

test('迁移：★ 老库（没有 image 列）跑一次 migrate 就补上，且数据一条不少', () => {
  const db = openDatabase(':memory:');
  try {
    // 造一个「迁移之前」的库：没有 image 列
    db.exec(schemaWithoutImage());
    assert.ok(!columnsOf(db, 'items').includes('image'), '前提：这个库确实没有 image 列');

    // 里面塞上真实数据 —— 迁移最怕的就是把数据弄丢
    db.exec(`
      INSERT INTO events (id,name,status,created_at) VALUES ('ev_1','老义卖','on_sale',1);
      INSERT INTO users (id,openid,name,role,created_at) VALUES ('u_1','op_1','同学甲','student',1);
      INSERT INTO items (id,event_id,stall_id,name,description,emoji,tint,
                         total_quota,remaining_quota,status,created_at)
      VALUES ('it_1','ev_1',NULL,'手作黄油曲奇','一盒六块','🍪','t-yellow',12,9,'on_sale',1);
      INSERT INTO reservations (id,event_id,item_id,user_id,qty,code,status,request_id,created_at)
      VALUES ('r_1','ev_1','it_1','u_1',1,'123456','reserved','req-1',1);
    `);

    // 迁移前查 image 是会报错的 —— 这就是线上没迁移时会看到的那个错
    assert.throws(() => db.prepare('SELECT image FROM items').all(),
      /no such column|image/i, '前提：老库查 image 应当报错');

    migrate(db);

    assert.ok(columnsOf(db, 'items').includes('image'), 'migrate 之后应当有 image 列');

    const row = db.prepare('SELECT * FROM items WHERE id = ?').get('it_1');
    assert.equal(row.name, '手作黄油曲奇');
    assert.equal(row.description, '一盒六块');
    assert.equal(row.emoji, '🍪');
    assert.equal(row.tint, 't-yellow');
    assert.equal(row.total_quota, 12);
    assert.equal(row.remaining_quota, 9, '剩余名额不能被迁移动过');
    assert.equal(row.status, 'on_sale');
    assert.equal(row.image, null, '新加的列对老数据应当是 NULL（界面回落到 emoji）');

    // 其它表也不能被顺手弄坏
    assert.equal(db.prepare('SELECT name FROM events WHERE id = ?').get('ev_1').name, '老义卖');
    assert.equal(db.prepare('SELECT code FROM reservations WHERE id = ?').get('r_1').code, '123456');
  } finally { db.close(); }
});

test('迁移：可以重复执行，不会报 duplicate column', () => {
  const db = openDatabase(':memory:');
  try {
    db.exec(schemaWithoutImage());
    migrate(db);
    migrate(db);
    migrate(db);

    const cols = columnsOf(db, 'items');
    assert.equal(cols.filter((c) => c === 'image').length, 1, 'image 只能有一列');
  } finally { db.close(); }
});

test('迁移：补上的列能被 repository 正常读写（不是只加了个空壳）', () => {
  const db = openDatabase(':memory:');
  try {
    db.exec(schemaWithoutImage());
    migrate(db);

    const repo = createSqliteRepository(db);
    const ev = repo.createEvent({ name: '义卖', status: 'on_sale' });
    const item = repo.createItem({
      eventId: ev.id, name: '帆布环保袋', totalQuota: 5, image: 'img_abc.jpg',
    });
    assert.equal(item.image, 'img_abc.jpg', 'createItem 要把 image 存进去');
    assert.equal(repo.getItem(item.id).image, 'img_abc.jpg', '也要能取出来');
  } finally { db.close(); }
});

test('迁移：★ 老库跑一次 migrate 就长出 cat_photos 表（新表也是迁移的一部分）', () => {
  // 加**列**要显式 ALTER，加**表**不用 —— SCHEMA 里全是 CREATE TABLE IF NOT EXISTS，
  // 老库上重跑一遍就建出来了。这条测的就是这个区别，免得以后有人以为
  // 「新表也只有新库才有」，跑去写一段多余的迁移代码。
  //
  // ★ 要模拟「比 cat_photos 还老的库」，得**把那张表从 SCHEMA 里抠掉**。
  //   第一版只复用了 schemaWithoutImage()，那个只删 image 列、不删表，
  //   于是「老库」里已经有 cat_photos 了 —— 前提断言当场就红。
  const db = openDatabase(':memory:');
  try {
    const old = SCHEMA.replace(/CREATE TABLE IF NOT EXISTS cat_photos \([\s\S]*?\n\);\n/, '');
    assert.notEqual(old, SCHEMA, '没能从 SCHEMA 里删掉 cat_photos，这个测试就没意义了');
    assert.ok(!/CREATE TABLE IF NOT EXISTS cat_photos/.test(old));

    db.exec(old);

    // 前提：这个「老库」确实还没有这张表
    assert.throws(() => db.prepare('SELECT * FROM cat_photos').all(),
      /no such table/i, '前提：老库里不该有 cat_photos');

    migrate(db);

    const cols = columnsOf(db, 'cat_photos');
    assert.deepEqual(cols.sort(), ['actor_id', 'cat_id', 'image', 'updated_at']);

    // 建出来就要能直接用，而且 cat_id 是主键（同一只猫只能有一行）
    const repo = createSqliteRepository(db);
    repo.setCatPhoto({ catId: 'c1', image: 'img_aa.jpg' });
    repo.setCatPhoto({ catId: 'c1', image: 'img_bb.jpg' });
    assert.equal(repo.listCatPhotos().length, 1, '同一只猫只该有一行');
    assert.equal(repo.listCatPhotos()[0].image, 'img_bb.jpg');
  } finally { db.close(); }
});
