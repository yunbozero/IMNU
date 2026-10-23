/**
 * 可改文案（喂养提示）：管理员在小程序里改，学生端刷新即见，不用发版提审。
 *
 * 三件事要同时成立才算"真的能用"：
 *   1. 服务端**校验合规词**（管理员手一滑写进「义卖 / 公益」就是审核事故）
 *   2. 客户端**一定有默认值**（接口挂了、第一次打开，都不能空一片）
 *   3. 两边的默认文案必须**逐字一致**，否则改之前和改之后看起来是两个东西
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import { createApi, COPY_DEFAULTS, COPY_LIMITS } from '../server/api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(p, 'utf8');

function fixture() {
  const db = openMigrated(':memory:');
  const repo = createSqliteRepository(db);
  const api = createApi({
    repo, secret: 'test-secret-0123456789abcdef', signToken: () => 'token',
    makeCode: () => '123456', imageDir: path.join(ROOT, '.tmp-copy'),
  });

  const owner = repo.createUser({ openid: 'op-o', name: '超管' }).user;
  repo.setUserRole(owner.id, 'admin');
  repo.bootstrapOwner(owner.id);
  const student = repo.createUser({ openid: 'op-s', name: '同学' }).user;

  return {
    api,
    owner: repo.findUserById(owner.id),
    student,
    close: () => db.close(),
  };
}

const goodCopy = () => ({
  catTips: {
    title: '校园喂养提示',
    items: COPY_DEFAULTS.catTips.items.map((i) => ({ ...i })),
  },
});

test('文案：没存过也能读，返回默认值（学生端永远有东西显示）', () => {
  const f = fixture();
  try {
    const r = f.api.getCopy();
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.copy.catTips, COPY_DEFAULTS.catTips);
  } finally { f.close(); }
});

test('文案：一级管理员能改，改完读到的就是新的', () => {
  const f = fixture();
  try {
    const body = goodCopy();
    body.catTips.title = '喂猫须知';
    body.catTips.items[0].text = '别喂火腿肠。';

    const saved = f.api.adminSetCopy({ body, user: f.owner });
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body));

    const got = f.api.getCopy();
    assert.equal(got.body.copy.catTips.title, '喂猫须知');
    assert.equal(got.body.copy.catTips.items[0].text, '别喂火腿肠。');
  } finally { f.close(); }
});

test('文案：学生没有权限改', () => {
  const f = fixture();
  try {
    const r = f.api.adminSetCopy({ body: goodCopy(), user: f.student });
    assert.equal(r.status, 403);
    assert.equal(f.api.getCopy().body.copy.catTips.title, COPY_DEFAULTS.catTips.title);
  } finally { f.close(); }
});

test('文案：合规词要拦住（这是审核红线，不能被一次手滑破掉）', () => {
  const f = fixture();
  try {
    for (const word of ['义卖', '公益', '价格']) {
      const body = goodCopy();
      body.catTips.items[1].text = `${word}相关规定`;
      const r = f.api.adminSetCopy({ body, user: f.owner });
      assert.equal(r.body.ok, false, `「${word}」应该被拒`);
      assert.match(r.body.message, /不能出现/);
    }
  } finally { f.close(); }
});

test('文案：长度超限要拒（标题 20 / 标签 6 / 说明 60 / 最多 6 行）', () => {
  const f = fixture();
  try {
    const tooLongTitle = goodCopy();
    tooLongTitle.catTips.title = '啊'.repeat(COPY_LIMITS.title + 1);
    assert.equal(f.api.adminSetCopy({ body: tooLongTitle, user: f.owner }).body.ok, false);

    const tooMany = goodCopy();
    tooMany.catTips.items = Array.from({ length: COPY_LIMITS.items + 1 },
      () => ({ label: '标签', text: '说明' }));
    assert.equal(f.api.adminSetCopy({ body: tooMany, user: f.owner }).body.ok, false);

    const emptyLabel = goodCopy();
    emptyLabel.catTips.items[0].label = '  ';
    assert.equal(f.api.adminSetCopy({ body: emptyLabel, user: f.owner }).body.ok, false);
  } finally { f.close(); }
});

test('文案：客户端默认值和服务端默认值逐字一致', () => {
  // ★ 不一致的话，「管理员还没改过」和「改过之后」看起来会像两个功能
  const copyJs = read(path.join(MP, 'services/copy.js'));
  const dataJs = read(path.join(MP, 'data/cats.js'));

  assert.match(copyJs, /title: '校园喂养提示'/, '客户端默认标题要和服务端一致');
  assert.match(copyJs, /FEEDING_TIPS/, '客户端默认条目复用 data/cats.js 里那份');

  // 服务端默认的四行，每一行都要能在客户端那份里找到
  for (const it of COPY_DEFAULTS.catTips.items) {
    assert.ok(dataJs.includes(it.text), `客户端缺这条文案：${it.text}`);
  }
});

test('文案：图鉴列表页读的是服务端文案，不是写死的标题', () => {
  const wxml = read(path.join(MP, 'pages/cats/index.wxml'));
  assert.doesNotMatch(wxml, />校园喂养提示</, '标题不能再写死在 wxml 里');
  assert.match(wxml, /\{\{tipsTitle\}\}/, '标题要来自 data');

  const js = read(path.join(MP, 'pages/cats/index.js'));
  assert.match(js, /services\/copy\.js/, '要用文案服务');
  assert.match(js, /copy\.refresh\(\)/, '进页面时拉一次服务端版本');

  // 管理端有编辑入口
  const adminWxml = read(path.join(MP, 'packageAdmin/pages/cats/index.wxml'));
  assert.match(adminWxml, /bindtap="saveCopy"/, '管理端要能保存文案');
  const adminJs = read(path.join(MP, 'packageAdmin/pages/cats/index.js'));
  assert.match(adminJs, /\/api\/admin\/copy/, '保存要走接口');
  assert.match(adminJs, /isSeniorManager/, '只有一级管理员及以上能看到编辑卡片');
});
