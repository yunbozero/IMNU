#!/usr/bin/env bash
# ============================================================
# 在**你本机**跑：把当前提交送到服务器，并在服务器上就地发布。
#
#   SERVER=root@<服务器IP> bash deploy/push-from-local.sh
#
# 为什么需要它：服务器（国内 ECS）经常连不上 github.com ——
# 于是 `deploy.sh` 的第一步 `git fetch` 就失败了，整条发布链路断掉，
# 而代码明明就在你手上。这个脚本让**发布完全不依赖服务器能不能连 GitHub**。
#
# ------------------------------------------------------------------
# 为什么用 git bundle，而不是 tar 解压
# ------------------------------------------------------------------
# tar/scp 的写法有两个坑：
#   · 它对「两个版本之间被删掉的文件」无能为力 —— 旧文件会留在线上，
#     而且不报任何错（线上跑着已经删掉的代码，最难查的一种）；
#   · 解压完工作区是脏的，git 状态和实际文件对不上。
# git bundle 是 git 官方的离线传输格式：服务器上 `git fetch <bundle>`
# 之后就是一个**正常的 git 仓库状态**，接着 deploy.sh 里那句
# `git reset --hard` 会老老实实把删掉的文件也删掉。
#
# ------------------------------------------------------------------
# 发布流程仍然是完整的那一套
# ------------------------------------------------------------------
# 本脚本最后调用服务器上的 deploy/deploy.sh（带 SKIP_FETCH=1），
# 所以**测试闸门、首页安装、重启、健康检查一个都不少** ——
# 比"手工解压"安全得多，那条路是跳过测试的。
# ============================================================
set -euo pipefail

SERVER="${SERVER:-}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/srv/bazaar/app}"
BUNDLE="$(mktemp -t imnu-XXXXXX.bundle)"
REMOTE_BUNDLE="/tmp/imnu-deploy.bundle"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() { rm -f "$BUNDLE"; }
trap cleanup EXIT

if [ -z "$SERVER" ]; then
  cat <<'USAGE'
用法：

  SERVER=root@<服务器IP> bash deploy/push-from-local.sh

可用变量：
  SERVER     必填。形如 root@112.0.0.1
  BRANCH     默认 main
  APP_DIR    默认 /srv/bazaar/app

例：
  SERVER=root@1.2.3.4 bash deploy/push-from-local.sh
USAGE
  exit 1
fi

# 在仓库里跑，别在别处跑（否则打出来的 bundle 是空的或错的）
cd "$(git rev-parse --show-toplevel)" || die "这里不是 git 仓库"

# 先跑一遍测试：服务器上那道闸门仍然在，但本地先过一遍能省一次往返，
# 也能在"服务器上没装依赖"之类的情况下早点发现问题
log "本地先跑一遍测试（服务器上还会再跑一次，那道闸门不会跳过）"
node tests/all.mjs || die "本地测试没过，先修好再发"

log "打包当前提交（$BRANCH）"
CUR="$(git rev-parse --short HEAD)"
git bundle create "$BUNDLE" "$BRANCH" >/dev/null || die "git bundle 失败"
printf '   %s（%s）\n' "$CUR" "$(git log -1 --pretty=%s | head -c 60)"

log "送到服务器"
scp -q "$BUNDLE" "$SERVER:$REMOTE_BUNDLE" || die "scp 失败 —— 检查 SERVER 和 SSH 是否通"

log "在服务器上就地发布"
# ★ 这里把 SKIP_FETCH=1 交给 deploy.sh：它跳过网络拉取，
#   但仍然会 reset、跑测试、装首页、重启、健康检查。
ssh "$SERVER" "set -e
  cd $APP_DIR
  # 从 bundle 取到本地的一个 ref 上，再让 deploy.sh 从它发布
  git fetch '$REMOTE_BUNDLE' 'refs/heads/$BRANCH:refs/remotes/local-deploy/$BRANCH' --force
  rm -f '$REMOTE_BUNDLE'
  SKIP_FETCH=1 TARGET_REF='local-deploy/$BRANCH' bash deploy/deploy.sh
" || die "服务器上的发布失败了 —— 看上面的输出，线上保持原状"

log "完成"
