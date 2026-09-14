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

test('部署：ExecStart 指向仓库里的入口文件', () => {
  const m = /^ExecStart=(\S+)\s+(\S+)$/m.exec(SERVICE());
  assert.ok(m, 'ExecStart 格式不对');
  assert.match(m[1], /\/node$/, 'ExecStart 应当用绝对路径调 node');

  const entry = m[2];
  // 阶段 3 才会写出这个文件；存在时路径必须对得上
  if (fs.existsSync(path.join(ROOT, entry))) {
    assert.ok(true);
  } else {
    assert.equal(entry, 'server/http.mjs',
      `入口 ${entry} 还不存在。阶段 3 会把 HTTP 服务写在这里，路径要保持一致。`);
  }
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

test('部署：nginx 里还有未替换的域名占位符（提醒换掉）', () => {
  assert.match(NGINX(), /YOUR_DOMAIN/, '应当保留 YOUR_DOMAIN 占位符，并让 bootstrap 检测出来');
  assert.match(BOOTSTRAP(), /YOUR_DOMAIN/, 'bootstrap.sh 应当检测占位符是否还没替换');
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
