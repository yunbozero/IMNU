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
IMAGE_DIR=/srv/bazaar/images
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

  # 法规要求拿到备案号后必须挂在页脚。备案通过前这里是占位符，
  # 每次发布都提醒一次，别让「待管局下发」就这么一直挂在线上。
  if grep -q '待管局下发' "$WWW_DIR/index.html"; then
    warn "首页页脚还是 ICP 备案号占位符（待管局下发）——拿到备案号后要在【仓库里】替换，见 docs/deploy-alicloud.md"
  fi

  # 公安联网备案是另一套，网站对外开通后 30 日内要办。这条提醒会一直响到填上为止。
  if grep -q '待备案' "$WWW_DIR/index.html"; then
    warn "首页页脚还是公网安备占位符（待备案）——公安联网备案有 30 天期限，见 docs/deploy-alicloud.md §5.6"
  fi
else
  warn "找不到 $SCRIPT_DIR/www/index.html，保留线上原来的页面"
fi

# ---------- 3.5 物品照片目录 ----------
# 服务写、nginx 读。bootstrap.sh 建过它，但**已经在跑的服务器不会再跑 bootstrap**，
# 所以升级到「有图片功能」这一版时必须在这里补上，否则传图会 500
# （目录不存在）或图片全 404（目录权限不对，nginx 进不去）。
#   install -d 是幂等的：已存在时只改权限和属主，不动里面的文件。
log "确认照片目录 $IMAGE_DIR"
install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$IMAGE_DIR"

# ---------- 4. 重启 ----------
log "重启 $SERVICE"

# ★ unit 文件也要跟着仓库走，和 www/index.html 一样「仓库是唯一事实来源」。
#
#   为什么必须这样：ReadWritePaths 里少了 /srv/bazaar/images，服务就写不了照片，
#   而 ProtectSystem=strict 下这个错误表现为 EROFS，看起来完全不像权限问题。
#   而 bootstrap.sh 只在最初装一次 unit —— 改了不同步的话，线上永远是旧的。
#
#   不做「先比对再决定」是因为那要额外依赖 diffutils。无条件装一遍 +
#   daemon-reload 是幂等的，没变化时 daemon-reload 本身就是空操作。
if [ -f "$SCRIPT_DIR/bazaar.service" ]; then
  install -m 644 "$SCRIPT_DIR/bazaar.service" "/etc/systemd/system/${SERVICE}.service"
  systemctl daemon-reload
  log "已同步 systemd 单元文件"
fi

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
