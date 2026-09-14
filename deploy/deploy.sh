#!/usr/bin/env bash
# ============================================================
# IMNU 校园义卖 · 发布脚本（在服务器上执行）
#
#   sudo bash /srv/bazaar/app/deploy/deploy.sh
#
# 核心原则：测试不过就不重启。宁可这次没发上去，
# 也不要把一个跑不起来的版本顶到线上——义卖当天没人能来救。
# ============================================================
set -euo pipefail

APP_USER=bazaar
APP_DIR=/srv/bazaar/app
SERVICE=bazaar
PORT=3000
BRANCH="${BRANCH:-main}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash deploy/deploy.sh"
[ -d "$APP_DIR/.git" ] || die "$APP_DIR 不是一个 git 仓库，请先 clone"

cd "$APP_DIR"

# ---------- 1. 取代码 ----------
log "拉取 origin/$BRANCH"
PREV="$(git rev-parse --short HEAD)"
git fetch --all --prune
git reset --hard "origin/$BRANCH"
NEXT="$(git rev-parse --short HEAD)"

if [ "$PREV" = "$NEXT" ]; then
  log "代码没有变化（$NEXT）"
else
  log "代码更新：$PREV → $NEXT"
  git --no-pager log --oneline "$PREV..$NEXT" | head -20
fi

# 拉下来的文件属于 root，改回运行账号
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ---------- 2. 跑测试（上线前的闸门） ----------
log "跑测试"
if ! node tests/all.mjs; then
  die "测试未通过，已中止。服务保持原状，线上还是 $PREV。"
fi

# ---------- 3. 重启 ----------
log "重启 $SERVICE"
systemctl restart "$SERVICE"
sleep 2

if ! systemctl is-active --quiet "$SERVICE"; then
  printf '\n\033[1;31m服务没能起来。最近日志：\033[0m\n'
  journalctl -u "$SERVICE" -n 40 --no-pager || true
  die "重启失败"
fi

# ---------- 4. 健康检查 ----------
log "健康检查"
for i in 1 2 3 4 5; do
  if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    curl -s "http://127.0.0.1:${PORT}/api/health"; echo
    log "发布完成：$NEXT"
    exit 0
  fi
  sleep 2
done

printf '\n\033[1;33m[!] 服务在跑，但 /api/health 没响应。\033[0m\n'
journalctl -u "$SERVICE" -n 30 --no-pager || true
die "健康检查失败"
