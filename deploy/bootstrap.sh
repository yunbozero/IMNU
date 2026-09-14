#!/usr/bin/env bash
# ============================================================
# IMNU 校园义卖 · 服务器初始化（在阿里云轻量服务器上以 root 跑一次）
#
#   sudo bash /srv/bazaar/app/deploy/bootstrap.sh
#
# 脚本是幂等的，重跑不会坏。它只负责「把机器准备好」，
# 不负责拉代码（代码要先有，因为这个脚本本身就在仓库里）。
# ============================================================
set -euo pipefail

# ---------- 常量：必须与 bazaar.service / nginx.conf 保持一致 ----------
# tests/deploy.test.mjs 会盯着这几处不许漂移
APP_USER=bazaar
BASE_DIR=/srv/bazaar
APP_DIR=/srv/bazaar/app
DATA_DIR=/srv/bazaar/data
BACKUP_DIR=/srv/bazaar/backup
SERVICE=bazaar
NODE_MAJOR=22
BACKUP_KEEP=14

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- 前置检查 ----------
[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash deploy/bootstrap.sh"
command -v apt-get >/dev/null || die "这个脚本假设是 Debian/Ubuntu。阿里云轻量请选 Ubuntu 镜像。"
[ -f "$SCRIPT_DIR/bazaar.service" ] || die "找不到 $SCRIPT_DIR/bazaar.service"

# ---------- 1. 系统更新与基础工具 ----------
log "更新软件包索引并安装基础工具"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg sqlite3 ufw >/dev/null

# ---------- 2. Node.js ----------
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]; then
  log "Node.js 已满足要求：$(node --version)，跳过安装"
else
  log "安装 Node.js ${NODE_MAJOR}.x"
  # 后端用了内置的 node:sqlite，Node 版本不够会直接跑不起来
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  node --version
fi

# ---------- 3. nginx 与 certbot ----------
log "安装 nginx 与 certbot"
apt-get install -y -qq nginx certbot python3-certbot-nginx >/dev/null

# ---------- 4. 运行账号 ----------
# 单独建一个不能登录的账号：万一服务被攻破，攻击者拿到的也只是这个权限
if id "$APP_USER" >/dev/null 2>&1; then
  log "用户 $APP_USER 已存在，跳过"
else
  log "创建运行账号 $APP_USER（禁止登录）"
  useradd --system --shell /usr/sbin/nologin --home-dir "$BASE_DIR" "$APP_USER"
fi

# ---------- 5. 目录 ----------
log "创建目录"
mkdir -p "$APP_DIR" "$DATA_DIR" "$BACKUP_DIR"
chown -R "$APP_USER:$APP_USER" "$BASE_DIR"
# 代码目录只读、数据目录可写，与 systemd 的 ProtectSystem=strict 呼应
chmod 750 "$DATA_DIR" "$BACKUP_DIR"

# ---------- 6. 防火墙 ----------
log "配置防火墙（只放 22 / 80 / 443）"
ufw allow 22/tcp   >/dev/null
ufw allow 80/tcp   >/dev/null
ufw allow 443/tcp  >/dev/null
ufw --force enable >/dev/null
ufw status | head -8

warn "别忘了阿里云控制台的【安全组】也要只放 22 / 80 / 443；"
warn "安全组和 ufw 是两道独立的门，只配一道等于没配。"

# ---------- 6.5 环境变量文件（密钥都放这里，不进 git） ----------
ENV_DIR=/etc/bazaar
ENV_FILE=/etc/bazaar/env

if [ -f "$ENV_FILE" ]; then
  log "$ENV_FILE 已存在，不覆盖（避免把已配好的密钥冲掉）"
else
  log "生成 $ENV_FILE，内含随机 SESSION_SECRET"
  install -d -m 750 -o root -g "$APP_USER" "$ENV_DIR"

  # 随机密钥用 openssl 生成，64 位十六进制
  SECRET="$(openssl rand -hex 32)"

  cat > "$ENV_FILE" <<EOF
# IMNU 校园义卖 · 服务端环境变量
# 这个文件不提交到 git。改了之后要重启服务才生效：
#   sudo systemctl restart ${SERVICE}

# 签发登录 token 用。已经随机生成好，不要外传，也不要在换机器时随手改。
SESSION_SECRET=${SECRET}

# 小程序后台 → 开发管理 → 开发设置 里的 AppID / AppSecret
# 不填的话 /api/login 会失败，其它接口不受影响。
WX_APPID=
WX_SECRET=
EOF

  # 只有 root 和运行账号能读。AppSecret 在这个文件里。
  chmod 640 "$ENV_FILE"
  chown root:"$APP_USER" "$ENV_FILE"
  warn "记得填 $ENV_FILE 里的 WX_APPID / WX_SECRET，然后 systemctl restart ${SERVICE}"
fi

# ---------- 7. systemd 单元 ----------
log "安装 systemd 单元 /etc/systemd/system/${SERVICE}.service"
install -m 644 "$SCRIPT_DIR/bazaar.service" "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
# 刻意不 start：代码可能还没拉下来，起来了也是不停重启

# 自动备份：备份单元 + 定时器
if [ -f "$SCRIPT_DIR/bazaar-backup.service" ] && [ -f "$SCRIPT_DIR/bazaar-backup.timer" ]; then
  log "安装自动备份（每天 03:30，保留 ${BACKUP_KEEP:-14} 份）"
  install -m 644 "$SCRIPT_DIR/bazaar-backup.service" "/etc/systemd/system/${SERVICE}-backup.service"
  install -m 644 "$SCRIPT_DIR/bazaar-backup.timer"   "/etc/systemd/system/${SERVICE}-backup.timer"
  systemctl daemon-reload
  systemctl enable --now "${SERVICE}-backup.timer" >/dev/null
  systemctl list-timers "${SERVICE}-backup.timer" --no-pager | head -3
  # 装完立刻先备一份，别等到今晚才发现脚本是坏的
  systemctl start "${SERVICE}-backup.service" || \
    warn "首次备份没成功。等数据库就绪后手动跑一次：sudo systemctl start ${SERVICE}-backup"
fi

# ---------- 8. nginx 站点（仅当域名已填好） ----------
SITE=/etc/nginx/sites-available/$SERVICE
if [ -f "$SCRIPT_DIR/nginx.conf" ]; then
  if grep -q 'YOUR_DOMAIN' "$SCRIPT_DIR/nginx.conf"; then
    warn "deploy/nginx.conf 里还是 YOUR_DOMAIN 占位符，先不装。"
    warn "把域名换掉之后重跑本脚本，或者手动执行："
    warn "  sed 's/YOUR_DOMAIN/你的域名/g' deploy/nginx.conf > $SITE"
    warn "  ln -sf $SITE /etc/nginx/sites-enabled/$SERVICE && nginx -t && systemctl reload nginx"
  else
    log "安装 nginx 站点配置"
    install -m 644 "$SCRIPT_DIR/nginx.conf" "$SITE"
    ln -sf "$SITE" "/etc/nginx/sites-enabled/$SERVICE"
    rm -f /etc/nginx/sites-enabled/default
    nginx -t && systemctl reload nginx
  fi
fi

# ---------- 完成 ----------
log "初始化完成"
cat <<'EOF'

接下来：

  1. 拉代码（如果还没拉）
       sudo -u bazaar git clone <仓库地址> /srv/bazaar/app

  2. 起服务
       sudo systemctl start bazaar
       sudo systemctl status bazaar

  3. 域名解析生效、备案通过之后申请证书
       sudo certbot --nginx -d 你的域名

  4. 验收
       curl -s https://你的域名/api/health

  5. 别忘了微信公众平台 → 开发设置 → 服务器域名
     把 https://你的域名 加进 request 合法域名

EOF
