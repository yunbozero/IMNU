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

# ★ 这一步必须**绝不允许无限等待**。
#   服务器（国内 ECS 尤其）连 github.com 又慢又不稳，而 git 默认会：
#     · 弹出用户名 / 密码提示 —— 脚本里没人能回答，于是永远停住；
#     · 首次连 SSH 时问「是否信任这台主机的指纹」—— 同样是无限等待；
#     · 传输中途卡死时一直等下去（HTTPS / SSH 都没有默认超时）。
#   三种现象都是「发布卡住了，什么都不说」，而且分不清是网络、认证还是真挂了。
#   下面这些设置把它变成：**最多等一小会儿，然后带着原因失败**。
#
#   这跟客户端那个 wx.login 超时是同一个道理 ——
#   一个没有上限的等待，等于一个没有信息的失败。
export GIT_TERMINAL_PROMPT=0

# 如果 bootstrap 给服务账号生成过 deploy key，root 跑 git 时也要用它。
# ★ 不指的话 SSH 会去翻 /root/.ssh —— 那里没有那把钥匙，结果是被拒；
#   而报错是 "Permission denied (publickey)"，完全看不出「钥匙其实有，
#   只是挂在另一个账号的家目录下」。
DEPLOY_KEY=/srv/bazaar/.ssh/id_ed25519
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 \
-o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new"
if [ -f "$DEPLOY_KEY" ]; then
  SSH_OPTS="$SSH_OPTS -i $DEPLOY_KEY -o IdentitiesOnly=yes"
fi
export GIT_SSH_COMMAND="ssh $SSH_OPTS"

PREV="$(git rev-parse --short HEAD)"

# http.lowSpeedLimit/Time 只管 HTTPS 传输；SSH 那边靠上面的 ServerAlive*
if ! git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 fetch --all --prune; then
  warn "取不到代码。按可能性排："
  warn ""
  warn "  1) ★ 代理掉了？（如果你之前一直能拉，多半就是这个）"
  warn "     典型报错：Failed to connect to github.com port 443 after 133919 ms"
  warn "     ——等两分钟才失败 = TCP 都建不起来，不是认证问题，也不是仓库权限。"
  warn "     先看 root 到底有没有代理（deploy.sh 是以 root 跑 git 的）："
  warn "       sudo env | grep -i proxy"
  warn "       sudo git config --global --get http.proxy"
  warn "     ★ 最容易踩的坑：**sudo 默认会清掉环境变量**，所以你在自己 shell 里"
  warn "       export 的 https_proxy 根本传不进 deploy.sh。两条干净的做法："
  warn "         · sudo -E bash deploy/deploy.sh          （-E 保留环境变量）"
  warn "         · sudo git config --global http.proxy http://127.0.0.1:<端口>"
  warn "           （配在 git 里，与 shell 无关，换了终端也还在）"
  warn "     代理起来之后先单独验一次再发布："
  warn "       sudo git -C $APP_DIR ls-remote origin main"
  warn ""
  warn "  2) 服务器直连确实不通（国内 ECS 很常见，没代理时就是这样）："
  warn "       curl -sS -m 8 -o /dev/null -w 'github -> %{http_code}\\n' https://github.com"
  warn ""
  warn "  3) 上面那条不通、但下面这条通 —— 换 SSH over 443（换个主机名常常就通了）："
  warn "       timeout 8 bash -c 'cat < /dev/null > /dev/tcp/ssh.github.com/443' && echo 通"
  warn "       git remote set-url origin ssh://git@ssh.github.com:443/<你>/IMNU.git"
  warn "     需要只读 deploy key（手册 §5 ②），本脚本会自动用 /srv/bazaar/.ssh 下那把。"
  warn ""
  warn "  4) 都不通 → 换国内镜像长期方案（阿里云 Codeup / Gitee），服务器从镜像拉。"
  warn "  5) 今天就要发 → 从本机打包 scp 上来（跳过测试闸门，本地测试要先过）。"
  warn "     完整步骤见 docs/deploy-alicloud.md「服务器连不上 github.com」一节。"
  die "取不到代码，线上还是 $PREV（服务没有被动过）"
fi

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

# ---------- 3.6 运行配置检查 ----------
# ★ 「服务端没填小程序密钥」这种故障**不会让服务启动失败**：
#   首页能访问、物品列表能看、猫猫图鉴正常 —— 只有登录接口一个人都过不去。
#   在小程序里的表现是「填了昵称点提交没反应 / 提示登录失败」，
#   看起来像网络问题或前端 bug，很容易查错方向。
#   启动时其实往 journald 打过一行警告，但那要主动去翻日志才看得到，
#   所以在**每次发布的输出里**也喊一声。
ENV_FILE=/etc/bazaar/env
if [ -f "$ENV_FILE" ]; then
  for key in WX_APPID WX_SECRET; do
    # 只判断「有没有值」，**绝不打印值本身** —— 那是 AppSecret，
    # 打出来就会落进终端记录、CI 日志和你的聊天窗口。
    if ! grep -qE "^${key}=.+" "$ENV_FILE"; then
      warn "$ENV_FILE 里的 ${key} 是空的 —— 所有人都登录不了，"
      warn "  小程序里的表现是「提交不了昵称」。修法见 docs/deploy-alicloud.md 5.5①"
    fi
  done
else
  warn "找不到 $ENV_FILE —— 服务能起来，但登录一定失败"
fi

# ---------- 3.7 nginx 站点配置检查 ----------
# ★ 这里**故意不自动覆盖** /etc/nginx/sites-available/$SERVICE。
#   原因：`certbot --nginx` 会把证书和 443 的 server 块**直接写进那个文件**，
#   拿仓库里这份 HTTP-only 的配置盖上去，HTTPS 配置会一起被抹掉 —— 网站当场变砖。
#   （bootstrap.sh 里有同样的顾虑，所以它检测到 ssl_certificate 就跳过安装。）
#   于是仓库里 nginx.conf 的改动**永远不会自动生效**，只能人工合并。
#   那就至少要做到：改动没生效时，每次发布都喊出来。
NGINX_SITE=/etc/nginx/sites-available/$SERVICE
if [ -f "$NGINX_SITE" ]; then
  if ! grep -q 'location /images/' "$NGINX_SITE"; then
    warn "nginx 站点里没有 /images/ 的 location —— **线上物品照片会全部 404**"
    warn "  （Node 那边其实实现了一份，但 location / 会先把 /images/ 接走，"
    warn "    去 /srv/bazaar/www 找文件，轮到不 Node）"
    warn "  修法：把 deploy/nginx.conf 里那段 location /images/ 合并进 $NGINX_SITE，然后"
    warn "    sudo nginx -t && sudo systemctl reload nginx"
  fi
else
  warn "找不到 $NGINX_SITE —— nginx 还在用默认站点？"
fi

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
