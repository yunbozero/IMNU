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
WWW_DIR=/srv/bazaar/www
SERVICE=bazaar
PORT=3000
BRANCH="${BRANCH:-main}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash deploy/deploy.sh"
[ -d "$APP_DIR/.git" ] || die "$APP_DIR 不是一个 git 仓库，请先 clone"

# ---------- 0. 放行 git safe.directory ----------
# 本脚本以 root 运行，但第 1 步结束时会 `chown -R $APP_USER "$APP_DIR"` ——
# 于是**第二次**发布时，仓库属主（bazaar）不等于当前用户（root），
# git 会以 "detected dubious ownership" 拒绝所有操作，连 fetch 都做不了。
# 结果：这个脚本从来没成功跑过第二遍，而报错完全指不到真正的原因（那行 chown）。
# 这不是安全问题，是脚本自己造成的权限切换，所以给它加一条例外；重复执行无副作用。
if ! git config --global --get-all safe.directory | grep -qxF "$APP_DIR"; then
  git config --global --add safe.directory "$APP_DIR"
  log "已放行 git safe.directory：$APP_DIR"
fi

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

# ---------- 3. 更新静态页 ----------
# ⚠️ nginx 不读仓库，它读的是 $WWW_DIR 下的副本。
#    所以「只拉代码 + 重启」不会更新首页文案 —— 改网站名称那次就踩了这个坑：
#    仓库里名字早改了，线上一直显示旧的，而且不报任何错。
#    放在测试闸门之后：测试没过就不该动线上的文件。
log "更新首页"
if [ -f "$SCRIPT_DIR/www/index.html" ]; then
  install -m 644 "$SCRIPT_DIR/www/index.html" "$WWW_DIR/index.html"
  log "已更新 $WWW_DIR/index.html"
else
  warn "找不到 $SCRIPT_DIR/www/index.html，保留线上原来的页面"
fi

# ---------- 4. 重启 ----------
log "重启 $SERVICE"
systemctl restart "$SERVICE"
sleep 2

if ! systemctl is-active --quiet "$SERVICE"; then
  printf '\n\033[1;31m服务没能起来。最近日志：\033[0m\n'
  journalctl -u "$SERVICE" -n 40 --no-pager || true
  die "重启失败"
fi

# ---------- 5. 健康检查 ----------
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
