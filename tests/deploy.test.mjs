/**
 * 部署产物校验。
 *
 * 这套文件本地跑不了（没有 Linux、没有 WSL 发行版），所以验收方式是
 * **跨文件一致性**：路径、端口、用户名、可写目录在四个文件之间必须对得上。
 *
 * 这类漂移正是「部署完不工作又找不到原因」的经典来源，而且肉眼看很难发现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = path.join(ROOT, 'deploy');
const DOC = path.join(ROOT, 'docs', 'deploy-alicloud.md');

const read = (f) => fs.readFileSync(f, 'utf8');

const SERVICE = () => read(path.join(DEPLOY, 'bazaar.service'));
const NGINX = () => read(path.join(DEPLOY, 'nginx.conf'));
const BOOTSTRAP = () => read(path.join(DEPLOY, 'bootstrap.sh'));
const DEPLOY_SH = () => read(path.join(DEPLOY, 'deploy.sh'));

/** 从 systemd 单元里取一个 Environment= 的值 */
function envOf(unit, key) {
  const m = new RegExp(`^Environment=${key}=(.+)$`, 'm').exec(unit);
  return m ? m[1].trim() : null;
}

/** 从 shell 脚本里取 VAR=value */
function shVar(src, name) {
  const m = new RegExp(`^${name}=(.+)$`, 'm').exec(src);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/* ============================================================
   文件齐全
   ============================================================ */

test('部署：四个产物与手册都在', () => {
  for (const f of ['bootstrap.sh', 'deploy.sh', 'bazaar.service', 'nginx.conf',
                   'bazaar-backup.service', 'bazaar-backup.timer']) {
    assert.ok(fs.existsSync(path.join(DEPLOY, f)), `缺少 deploy/${f}`);
  }
  assert.ok(fs.existsSync(DOC), '缺少 docs/deploy-alicloud.md');
});

/* ============================================================
   ★ 自动备份：目录、用户、保留份数都要对得上
   ============================================================ */

const BACKUP_UNIT = () => read(path.join(DEPLOY, 'bazaar-backup.service'));
const BACKUP_TIMER = () => read(path.join(DEPLOY, 'bazaar-backup.timer'));

test('备份：数据库与备份目录与主服务、初始化脚本一致', () => {
  const unit = BACKUP_UNIT();

  assert.equal(envOf(unit, 'DB_PATH'), envOf(SERVICE(), 'DB_PATH'),
    '备份脚本读的库必须和主服务写的是同一个');

  const backupDir = envOf(unit, 'BACKUP_DIR');
  assert.equal(backupDir, shVar(BOOTSTRAP(), 'BACKUP_DIR'),
    'BACKUP_DIR 与 bootstrap.sh 建出来的目录不一致');

  assert.equal(envOf(unit, 'BACKUP_KEEP'), shVar(BOOTSTRAP(), 'BACKUP_KEEP'),
    '保留份数与 bootstrap.sh 不一致');

  assert.match(unit, new RegExp(`^User=${shVar(BOOTSTRAP(), 'APP_USER')}$`, 'm'),
    '备份必须以运行账号执行，否则会写出 root 拥有的文件');
});

test('备份：ReadWritePaths 必须同时放行数据目录和备份目录', () => {
  const rw = /^ReadWritePaths=(.+)$/m.exec(BACKUP_UNIT());
  assert.ok(rw, '备份单元缺少 ReadWritePaths');
  const writable = rw[1].trim().split(/\s+/);

  // 源库要读写（VACUUM INTO 会碰 -wal / -shm）
  assert.ok(writable.includes(path.posix.dirname(envOf(BACKUP_UNIT(), 'DB_PATH'))),
    'ProtectSystem=strict 下，不放开数据目录 SQLite 读不了源库');
  // 目标目录要能写
  assert.ok(writable.includes(envOf(BACKUP_UNIT(), 'BACKUP_DIR')),
    '不放开备份目录就写不出备份文件');
});

test('备份：定时器要能在关机错过后补跑', () => {
  const timer = BACKUP_TIMER();
  assert.match(timer, /^OnCalendar=/m, '缺少 OnCalendar');
  assert.match(timer, /^Persistent=true$/m,
    '缺 Persistent=true 的话，机器关机错过就永远不补跑 —— 校园服务器经常不是 7x24 开着');
  assert.match(timer, /^WantedBy=timers\.target$/m, '缺少 [Install]，开机不会自启');
});

test('备份：备份单元的两个文件都无 BOM、无 CRLF', () => {
  for (const f of ['bazaar-backup.service', 'bazaar-backup.timer']) {
    const raw = fs.readFileSync(path.join(DEPLOY, f));
    assert.notEqual(raw[0], 0xef, `${f} 带 BOM`);
    assert.equal(raw.includes(Buffer.from('\r\n')), false, `${f} 里是 CRLF`);
  }
});

test('备份：bootstrap.sh 会安装并启用备份定时器', () => {
  const src = BOOTSTRAP();
  assert.match(src, /bazaar-backup\.timer/, 'bootstrap.sh 应当安装备份定时器');
  assert.match(src, /enable --now "\$\{SERVICE\}-backup\.timer"/, '应当启用定时器');
  assert.match(src, /systemctl start "\$\{SERVICE\}-backup\.service"/,
    '装完应当立刻试备一份，否则要等到当晚才发现脚本是坏的');
});

/* ============================================================
   ★ 跨文件一致性
   ============================================================ */

test('部署：运行用户名在三处一致', () => {
  const user = shVar(BOOTSTRAP(), 'APP_USER');
  assert.ok(user, 'bootstrap.sh 里应当有 APP_USER');

  const unit = SERVICE();
  assert.match(unit, new RegExp(`^User=${user}$`, 'm'), 'systemd 的 User= 与 bootstrap.sh 不一致');
  assert.match(unit, new RegExp(`^Group=${user}$`, 'm'), 'systemd 的 Group= 与 bootstrap.sh 不一致');
});

test('部署：代码目录在 systemd 与两个脚本之间一致', () => {
  const appDir = shVar(BOOTSTRAP(), 'APP_DIR');
  const deployDir = shVar(DEPLOY_SH(), 'APP_DIR');
  assert.ok(appDir && deployDir);
  assert.equal(appDir, deployDir, 'bootstrap.sh 与 deploy.sh 的 APP_DIR 不一致');

  const m = /^WorkingDirectory=(.+)$/m.exec(SERVICE());
  assert.ok(m, 'systemd 单元缺少 WorkingDirectory');
  assert.equal(m[1].trim(), appDir, 'systemd 的 WorkingDirectory 与脚本不一致');
});

test('部署：端口在 systemd、nginx、发布脚本三处一致', () => {
  const port = envOf(SERVICE(), 'PORT');
  assert.ok(port, 'systemd 单元缺少 Environment=PORT');

  const proxy = /proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(NGINX());
  assert.ok(proxy, 'nginx 里找不到 proxy_pass');
  assert.equal(proxy[1], port, 'nginx 代理的端口与 systemd 不一致');

  assert.equal(shVar(DEPLOY_SH(), 'PORT'), port, 'deploy.sh 里的端口与 systemd 不一致');
});

test('部署：nginx 只反代到本机回环地址，不对外暴露 Node 端口', () => {
  const proxy = /proxy_pass\s+http:\/\/([^:]+):/.exec(NGINX());
  assert.ok(proxy, '找不到 proxy_pass');
  assert.equal(proxy[1], '127.0.0.1',
    'Node 必须只监听回环地址，由 nginx 对外。否则 3000 端口裸奔。');
});

test('部署：SQLite 数据目录必须是 systemd 放行的可写目录', () => {
  const dbPath = envOf(SERVICE(), 'DB_PATH');
  assert.ok(dbPath, 'systemd 单元缺少 Environment=DB_PATH');

  const rw = /^ReadWritePaths=(.+)$/m.exec(SERVICE());
  assert.ok(rw, 'systemd 单元缺少 ReadWritePaths');

  const writable = rw[1].trim().split(/\s+/);
  const dbDir = path.posix.dirname(dbPath);

  assert.ok(writable.includes(dbDir),
    `ProtectSystem=strict 会把整个文件系统挂成只读，` +
    `而 DB_PATH 在 ${dbDir}，它必须出现在 ReadWritePaths 里，否则 SQLite 写不进去。` +
    `（WAL 模式还会在同目录生成 -wal / -shm，所以放行的是整个目录而不是单个文件）`);

  // 数据目录也必须和 bootstrap.sh 建出来的一致
  assert.equal(dbDir, shVar(BOOTSTRAP(), 'DATA_DIR'), 'DB_PATH 的目录与 bootstrap.sh 建的不一致');
});

/* ============================================================
   systemd 单元本身
   ============================================================ */

test('部署：systemd 单元具备进程守护与开机自启', () => {
  const unit = SERVICE();
  assert.match(unit, /^Restart=always$/m, '缺少 Restart=always，进程挂了不会自动拉起');
  assert.match(unit, /^RestartSec=\d+$/m, '缺少 RestartSec，崩溃时会疯狂重启');
  assert.match(unit, /^WantedBy=multi-user\.target$/m, '缺少 [Install] 段，开机不会自启');
  assert.match(unit, /^Type=simple$/m);
  assert.match(unit, /^\[Unit\]$/m);
  assert.match(unit, /^\[Service\]$/m);
  assert.match(unit, /^\[Install\]$/m);
});

test('部署：systemd 单元启用了基础加固', () => {
  const unit = SERVICE();
  for (const key of ['NoNewPrivileges', 'PrivateTmp', 'ProtectSystem', 'ProtectHome',
                     'ProtectKernelTunables', 'RestrictAddressFamilies']) {
    assert.match(unit, new RegExp(`^${key}=`, 'm'), `缺少加固项 ${key}`);
  }
  assert.match(unit, /^ProtectSystem=strict$/m);
});

test('部署：Node 版本检查必须校验次版本，而且要真的 require 一次', () => {
  const src = BOOTSTRAP();

  // node:sqlite 从 Node 22.5 才有。只比大版本的话，22.0~22.4 会被误判成"满足要求"，
  // 然后服务启动时报 "Cannot find module 'node:sqlite'" —— 报错完全不指向根因。
  const m = /MIN_NODE_MINOR=(\d+)/.exec(src);
  assert.ok(m, '缺少 MIN_NODE_MINOR');
  assert.ok(Number(m[1]) >= 5,
    `MIN_NODE_MINOR 应当 >= 5（node:sqlite 从 22.5 开始），实际 ${m[1]}`);

  assert.match(src, /min < needMin/, '版本比较里必须包含次版本号');

  // 光看版本号还不够：发行版编译 Node 时可能根本没带 sqlite 模块。
  // 直接 require 一下才是真的验证。
  assert.match(src, /require\(['"]node:sqlite['"]\)/,
    "必须真的 require('node:sqlite') 一次，只看版本号看不出模块在不在");
});

test('部署：本机 Node 确实带 node:sqlite（否则前后端都跑不起来）', async () => {
  // ★ 刻意用进程内 import，不起子进程。
  //   起子进程要管道，而受限沙箱禁止命名管道 —— 那样这条测试会因为
  //   "环境跑不了"而失败，和 node:sqlite 在不在毫无关系，纯粹是假信号。
  await assert.doesNotReject(() => import('node:sqlite'),
    '本机 Node 缺少 node:sqlite —— 前后端都依赖它');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Node 版本太低');
});

test('部署：bootstrap.sh 优先用发行版自带的 Node（少一层第三方源依赖）', () => {
  const src = BOOTSTRAP();
  // Ubuntu 26.04 自带 Node 22，够用；先试发行版，不行再退回 NodeSource
  const distroAt = src.indexOf('apt-get install -y -qq nodejs');
  const nodesourceAt = src.indexOf('deb.nodesource.com');
  assert.ok(distroAt > 0, '应当先尝试发行版仓库');
  assert.ok(nodesourceAt > 0, '应当保留 NodeSource 作为退路');
  assert.ok(distroAt < nodesourceAt,
    '必须先试发行版自带的 Node —— 少一个第三方源就少一处会失败的地方');
});

test('部署：ExecStart 指向仓库里的入口文件', () => {
  const m = /^ExecStart=(\S+)\s+(\S+)$/m.exec(SERVICE());
  assert.ok(m, 'ExecStart 格式不对');
  assert.match(m[1], /\/node$/, 'ExecStart 应当用绝对路径调 node');

  const entry = m[2];
  assert.ok(fs.existsSync(path.join(ROOT, entry)),
    `ExecStart 指向的 ${entry} 不存在 —— 服务会起来就崩`);
  assert.equal(entry, 'server/http.mjs');
});

test('部署：密钥走 EnvironmentFile，不能写进单元文件', () => {
  const unit = SERVICE();

  // 密钥进了单元文件就等于进了 git
  assert.doesNotMatch(unit, /Environment=SESSION_SECRET=/,
    'SESSION_SECRET 不能硬编码在单元文件里');
  assert.doesNotMatch(unit, /Environment=WX_SECRET=/,
    'AppSecret 不能硬编码在单元文件里');

  assert.match(unit, /^EnvironmentFile=-\/etc\/bazaar\/env$/m,
    '应当用 EnvironmentFile 加载密钥，开头的 - 表示文件缺失也不报错');
});

test('部署：bootstrap.sh 会生成随机密钥并收紧权限', () => {
  const src = BOOTSTRAP();
  assert.match(src, /openssl rand -hex 32/, '应当用 openssl 生成随机 SESSION_SECRET');
  assert.match(src, /chmod 640 "\$ENV_FILE"/, '环境变量文件权限应当收紧到 640');
  assert.match(src, /if \[ -f "\$ENV_FILE" \]/, '已存在时不能覆盖，否则会把配好的密钥冲掉');
  // 反过来确认没把密钥写死在脚本里
  assert.doesNotMatch(src, /SESSION_SECRET=[0-9a-f]{32}/, '不应该有硬编码的密钥');
});

test('部署：单元文件不带 BOM、不带 CRLF', () => {
  // CRLF 会让 Linux 上的 systemd / bash 直接报莫名其妙的错
  for (const f of ['bazaar.service', 'bootstrap.sh', 'deploy.sh', 'nginx.conf']) {
    const raw = fs.readFileSync(path.join(DEPLOY, f));
    assert.notEqual(raw[0], 0xef, `${f} 带 BOM`);
    assert.equal(raw.includes(Buffer.from('\r\n')), false, `${f} 里是 CRLF 换行，Linux 上会出错`);
  }
});

/* ============================================================
   nginx 配置
   ============================================================ */

test('部署：nginx 配置里不能提前出现证书指令', () => {
  const conf = NGINX();
  // certbot 跑之前证书文件不存在，写上 ssl_certificate 会让 nginx -t 直接失败
  assert.doesNotMatch(conf, /^\s*ssl_certificate\s/m,
    'nginx.conf 里不该有 ssl_certificate —— 证书由 certbot --nginx 自动补上');
  assert.match(conf, /certbot --nginx/, '注释里应当写清楚用 certbot 申请证书');
});

test('部署：nginx 转发了必要的代理头', () => {
  const conf = NGINX();
  for (const h of ['Host', 'X-Real-IP', 'X-Forwarded-For', 'X-Forwarded-Proto']) {
    assert.match(conf, new RegExp(`proxy_set_header\\s+${h}\\s`), `缺少 proxy_set_header ${h}`);
  }
});

/* ============================================================
   根路径：备案抽查不能是 404
   ============================================================ */

test('部署：根路径必须提供页面，不能返回 404', () => {
  const conf = NGINX();

  // 备案通过后管局/阿里云会抽查。http://域名/ 返回 404 可能被判定为
  // 「备案信息与实际提供的服务不符」，严重的话备案会被注销。
  assert.doesNotMatch(conf, /location\s*\/\s*\{[^}]*return\s+404/,
    '根路径不能只返回 404 —— 备案抽查会看到');
  assert.match(conf, /location\s*\/\s*\{[^}]*root\s+\S+/,
    '根路径应当配置一个静态站点根目录');
});

test('部署：nginx 的网站根目录与 bootstrap.sh 建的目录一致', () => {
  const m = /location\s*\/\s*\{[^}]*root\s+(\S+?);/.exec(NGINX());
  assert.ok(m, 'nginx 里找不到 root 指令');
  assert.equal(m[1].trim(), shVar(BOOTSTRAP(), 'WWW_DIR'),
    'nginx 的 root 与 bootstrap.sh 的 WWW_DIR 不一致，页面会 404');
});

test('部署：首页文件存在，且 bootstrap.sh 会把它装过去', () => {
  const page = path.join(DEPLOY, 'www', 'index.html');
  assert.ok(fs.existsSync(page), '缺少 deploy/www/index.html');

  const src = BOOTSTRAP();
  assert.match(src, /install -m 644 "\$SCRIPT_DIR\/www\/index\.html"/,
    'bootstrap.sh 应当把首页装到网站根目录');
  assert.match(src, /先放一个占位页/, '缺少页面文件时应当有兜底，不能让根路径空着');
});

test('部署：发布脚本也要更新首页（只拉代码的话线上永远显示旧文案）', () => {
  // 踩过的坑：nginx 不读仓库，读的是 WWW_DIR 下的副本，而副本只有 bootstrap.sh 装。
  // 于是 deploy.sh 拉完代码、重启、健康检查全绿，首页文案却一个字没变 ——
  // 改网站名称那次就是这样：仓库里早改了，线上还是「校园流浪猫救助」，且不报错。
  const sh = DEPLOY_SH();

  assert.equal(shVar(sh, 'WWW_DIR'), shVar(BOOTSTRAP(), 'WWW_DIR'),
    'deploy.sh 与 bootstrap.sh 的 WWW_DIR 必须一致，否则装到了别的目录');

  assert.match(sh, /install -m 644 "\$SCRIPT_DIR\/www\/index\.html" "\$WWW_DIR\/index\.html"/,
    'deploy.sh 必须把首页重装到 WWW_DIR，否则改了文案线上不会变');

  // 而且要排在测试闸门之后：测试没过就不该动线上文件
  const testAt = sh.indexOf('node tests/all.mjs');
  const installAt = sh.indexOf('$WWW_DIR/index.html');
  assert.ok(testAt !== -1, 'deploy.sh 里找不到测试闸门');
  assert.ok(installAt !== -1, 'deploy.sh 里找不到首页安装步骤');
  assert.ok(testAt < installAt,
    '更新首页必须排在测试之后 —— 测试没过还去改线上文件，就失去了闸门的意义');
});

test('部署：发布脚本要先放行 git safe.directory（否则第二次发布必挂）', () => {
  // 第二个「跑第二遍才暴露」的坑：脚本以 root 跑 git，但第 1 步结束会把仓库
  // chown 给服务账号。于是第二次执行时仓库属主 ≠ 当前用户，git 直接拒绝：
  //   fatal: detected dubious ownership in repository
  // 报错完全指不到那行 chown，而且现象是「发布没效果」—— 很容易误判成网络问题。
  const sh = DEPLOY_SH();

  // 前提：脚本确实会把仓库交给服务账号（这正是必须放行的原因）
  assert.match(sh, /chown -R "\$APP_USER:\$APP_USER" "\$APP_DIR"/,
    '脚本会把仓库 chown 给服务账号 —— 这就是 safe.directory 必须存在的原因');

  assert.match(sh, /safe\.directory/,
    'deploy.sh 必须自己加 safe.directory 例外，不能指望手上有个人去敲那条命令');

  const safeAt = sh.indexOf('safe.directory');
  const fetchAt = sh.indexOf('git fetch');
  assert.ok(fetchAt !== -1, 'deploy.sh 里找不到 git fetch');
  assert.ok(safeAt < fetchAt,
    'safe.directory 必须在任何 git 操作之前设置，否则第一次 git 调用就会挂');
});

test('部署：网站名称符合个人备案规范，且 title / h1 / 手册三处一致', () => {
  const html = read(path.join(DEPLOY, 'www', 'index.html'));

  const m = /<title>([^<]+)<\/title>/.exec(html);
  assert.ok(m, '首页缺 <title>');
  const name = m[1].trim();

  // 名称是要填进备案表单的，三处必须逐字一致。
  // 改动时最容易只改一处，于是「备案信息与实际提供的服务不符」。
  assert.match(html, new RegExp(`<h1>${name}</h1>`),
    `<h1> 必须和 <title> 里的网站名称完全一致（当前 <title> 是「${name}」）`);
  const handbook = read(path.join(ROOT, 'docs', 'deploy-alicloud.md'));
  assert.ok(handbook.includes(name),
    `备案手册里要记下网站名称「${name}」，否则下次填表只能靠猜`);

  // ★ 个人备案的命名规范：不得含地区 / 行业 / 企业 / 姓名类词。
  //   「校园流浪猫救助」就是在这条上被驳回的（校园=机构、救助=公益）。
  const BANNED = [
    '校园', '大学', '学院', '学校', '中学', '中国', '中华', '全国', '内蒙',
    '公益', '慈善', '募捐', '捐款', '捐赠', '救助', '志愿者', '义工', '爱心',
    '协会', '学会', '中心', '之家', '工作室', '传媒', '公司', '企业', '集团',
    '商城', '商店', '网', '科技', '教育', '医疗', '医院', '新闻', '论坛', '社区',
  ];
  const hit = BANNED.filter((w) => name.includes(w));
  assert.deepEqual(hit, [],
    `网站名称「${name}」含有个人备案不允许的词：${hit.join('、')}`);

  // 反过来，必须能一眼看出这是个人站点
  assert.match(name, /小记|手记|笔记|日记|随笔|日常|记录|我的|个人/,
    `网站名称「${name}」缺少体现个人属性的词（小记 / 手记 / 笔记 / 记录 这类）`);
});

test('部署：首页正文符合个人主体口径，不出现公益与金额', () => {
  const html = read(path.join(DEPLOY, 'www', 'index.html'));

  // 和备案时填的服务内容对得上，抽查才不会被判定为不符
  assert.match(html, /猫/, '首页应当说明这个站是做什么的');
  assert.match(html, /小程序/, '应当说明服务于小程序');
  assert.match(html, /仅(用于)?(登记|锁定)[^。，]{0,8}名额/, '应当保留"仅登记名额"这句合规声明');

  // ★ 个人备案的关键：必须声明不是学校/机构官方。
  //   自称"官方"而主体是个人，是备案被驳回或事后被注销的常见原因。
  assert.match(html, /(尚无|非|不是)[^。，]{0,12}官方/, '应当明确声明没有官方身份');

  // ★ 个人网站不得以公益 / 组织名义运营 —— 涉及公开募捐要《慈善法》资质。
  //   旧首页写的「义卖所得用于流浪猫的医疗与绝育」正是这一条的风险点。
  for (const w of ['公益', '慈善', '募捐', '捐款', '捐赠', '救助', '志愿者', '协会', '自发组织', '我们是一群']) {
    assert.ok(!html.includes(w), `首页不该出现「${w}」（个人备案不得以公益/组织名义运营）`);
  }

  // ★ 学校 / 地区字样会让审核把个人站看成机构站 —— 和备注被驳回的是同一个坑。
  //   「义卖」也一并去掉：个人网站不宜出现交易色彩，已压成「闲置物品登记」。
  for (const w of ['内蒙古', '校园', '大学', '学院', '师范', '学校', '义卖']) {
    assert.ok(!html.includes(w), `首页不该出现「${w}」（会被当成机构或经营性站点）`);
  }

  // 口吻必须是第一人称个人，不能是组织宣言
  assert.match(html, /我个人|本人/, '首页应当用第一人称，体现个人主体');

  for (const w of ['价格', '金额', '订单', '购买', '支付']) {
    assert.ok(!html.includes(w), `首页不该出现「${w}」`);
  }
  assert.doesNotMatch(html, /¥|\d+\s*元/, '首页不该出现金额');
});

test('部署：备案备注符合个人口径（第一人称、无组织与公益色彩）', () => {
  const handbook = read(path.join(ROOT, 'docs', 'deploy-alicloud.md'));

  // 备注是填进备案表单的定稿，记在手册里，避免下次又临时想一段被驳回的
  const m = /###\s*备案备注[\s\S]*?^>\s*(.+)$/m.exec(handbook);
  assert.ok(m, '手册里要记下备案备注的定稿');
  const text = m[1].trim();

  assert.ok(text.length >= 20, `备注只有 ${text.length} 字，说不清用途，管局一般会打回`);
  assert.match(text, /我/, '备注必须用第一人称');

  // 「组织」「项目」这类词会把个人主体写成团队，一样会被驳
  for (const w of ['我们', '公益', '慈善', '募捐', '捐款', '捐赠', '救助', '志愿者',
                   '协会', '组织', '内蒙古', '校园', '大学', '学院', '师范', '学校',
                   '公司', '企业', '平台', '商城', '义卖']) {
    assert.ok(!text.includes(w), `备案备注不该出现「${w}」`);
  }
});

test('部署：网站根目录对 nginx 可读（worker 不是运行账号）', () => {
  // nginx 的 worker 跑在 www-data 下，不是 bazaar。
  // 目录要是 750 且属主是 bazaar，nginx 根本进不去 —— 表现是 403。
  assert.match(BOOTSTRAP(), /chmod 755 "\$WWW_DIR"/,
    'www 目录必须放行到 755，否则 nginx（www-data）读不到');
});

test('部署：检测域名占位符时必须锚定 server_name，不能扫整个文件', () => {
  // 我踩过的坑：nginx.conf 头部注释里写着「把 YOUR_DOMAIN 换成你的域名」，
  // 而 bootstrap.sh 用 `grep -q 'YOUR_DOMAIN' 整个文件` 判断域名填了没有 ——
  // 于是永远匹配，站点永远装不上，nginx 一直服务默认页。
  // 现象是「访问域名看到 Welcome to nginx」，完全不指向真正的原因。
  const conf = NGINX();
  const bootstrap = BOOTSTRAP();

  // 前提：注释里确实还有这个词
  assert.ok(conf.includes('YOUR_DOMAIN'),
    'nginx.conf 的注释里应当还有操作说明（这条测试的前提）');

  const m = /grep[^\n]*YOUR_DOMAIN[^\n]*/.exec(bootstrap);
  assert.ok(m, 'bootstrap.sh 里应当有占位符检测');
  assert.match(m[0], /server_name/,
    '检测必须锚定 server_name 行；扫整个文件的话，注释里的 YOUR_DOMAIN 会让它永远误判');
});

test('部署：nginx 的 server_name 必须是真实域名，不能留着占位符', () => {
  const m = /^\s*server_name\s+([^;]+);/m.exec(NGINX());
  assert.ok(m, 'nginx 里找不到 server_name');

  const names = m[1].trim().split(/\s+/);
  assert.ok(names.length > 0);

  for (const n of names) {
    assert.notEqual(n, 'YOUR_DOMAIN', 'server_name 还是占位符，nginx 不会对外服务');
    assert.match(n, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i, `server_name 不像域名：${n}`);
  }

  // 主域名必须在里面（www 可选）
  assert.ok(names.some((n) => n === 'neishidemao.cn' || n === 'www.neishidemao.cn'),
    `server_name 里没找到本项目域名：${names.join(' ')}`);
});

test('部署：小程序里的生产地址要和 nginx 的域名对得上', () => {
  const names = /^\s*server_name\s+([^;]+);/m.exec(NGINX())[1].trim().split(/\s+/);
  const domain = names.find((n) => !n.startsWith('www.')) || names[0];

  const cfg = fs.readFileSync(path.join(ROOT, 'miniprogram', 'config.js'), 'utf8');
  const base = /PROD_BASE\s*=\s*'([^']+)'/.exec(cfg);
  assert.ok(base, '找不到 PROD_BASE');

  assert.equal(base[1], `https://${domain}`,
    `小程序的 PROD_BASE 应当指向 nginx 的域名（https://${domain}）`);
});

/* ============================================================
   脚本本身
   ============================================================ */

test('部署：两个脚本都有 shebang 和严格模式', () => {
  for (const [name, src] of [['bootstrap.sh', BOOTSTRAP()], ['deploy.sh', DEPLOY_SH()]]) {
    assert.match(src, /^#!\/usr\/bin\/env bash/, `${name} 缺少 shebang`);
    assert.match(src, /^set -euo pipefail$/m, `${name} 缺少 set -euo pipefail`);
  }
});

test('部署：bootstrap.sh 必须幂等（已存在的用户和目录不能报错）', () => {
  const src = BOOTSTRAP();
  assert.match(src, /if id "\$APP_USER" >\/dev\/null/, '建用户前应当先判断是否已存在');
  assert.match(src, /mkdir -p/, '建目录应当用 mkdir -p');
  assert.match(src, /apt-get install -y -qq/, '装包应当用 -y 非交互');
});

test('部署：bootstrap.sh 不动代码目录的写权限、只开数据目录', () => {
  const src = BOOTSTRAP();
  assert.match(src, /chmod 750 "\$DATA_DIR"/, '数据目录权限应当收紧');
  assert.match(src, /chown -R "\$APP_USER:\$APP_USER" "\$BASE_DIR"/, '目录应当归属运行账号');
});

test('部署：发布脚本先跑测试、后重启（顺序不能反）', () => {
  const src = DEPLOY_SH();
  const testAt = src.indexOf('node tests/all.mjs');
  const restartAt = src.indexOf('systemctl restart');

  assert.ok(testAt > 0, 'deploy.sh 里应当跑测试');
  assert.ok(restartAt > 0, 'deploy.sh 里应当重启服务');
  assert.ok(testAt < restartAt,
    '测试必须在重启之前。顺序反了就等于没有闸门，坏版本照样上线。');

  assert.match(src, /die "测试未通过/, '测试失败必须中止，而不是继续重启');
});

test('部署：发布脚本带健康检查，失败会打出日志', () => {
  const src = DEPLOY_SH();
  assert.match(src, /\/api\/health/, '缺少应用健康检查');
  assert.match(src, /journalctl -u "\$SERVICE"/, '失败时应当打出 journalctl 日志，否则没法排查');
});

/* ============================================================
   手册
   ============================================================ */

test('部署：手册覆盖了最关键的几件事', () => {
  const doc = read(DOC);
  assert.match(doc, /备案/, '必须写备案');
  assert.match(doc, /1[–-]3 周/, '必须写清备案的时间量级');
  assert.match(doc, /certbot/, '必须写怎么申请证书');
  assert.match(doc, /request 合法域名/, '必须提醒去小程序后台配置服务器域名');
  assert.match(doc, /安全组/, '必须提醒配置阿里云安全组');
  assert.match(doc, /服务器过期不续，备案会被注销/, '必须写明备案与服务器的绑定关系');
});

test('部署：手册明确说了不要买什么', () => {
  const doc = read(DOC);
  for (const naive of ['云数据库', 'SSL 证书']) {
    assert.ok(doc.includes(naive), `手册里应当明确提醒不要买${naive}`);
  }
});

test('部署：手册给出了倒排时间线', () => {
  const doc = read(DOC);
  assert.match(doc, /T[−-]21\s*天/, '缺少倒排时间线');
  assert.match(doc, /今天/, '时间线必须让人知道现在就要动作');
});
