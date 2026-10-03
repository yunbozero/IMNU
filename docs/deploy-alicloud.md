# 阿里云部署手册

> 目标：把这套后端跑在阿里云轻量应用服务器上，供微信小程序调用。
> 状态：**部署脚本已就绪**，等阶段 3 产出 `server/http.mjs` 后即可执行。

---

## 0. 时间线（先看这个）

**备案是 1–3 周的不可压缩等待期，而且只能等。** 所以它是整个项目的关键路径，今天就该去启动。

倒排：

| 时点 | 要做完的事 |
| --- | --- |
| **今天** | 买域名、买服务器、**提交备案** |
| T−21 天 | 备案通过 → 配好 HTTPS，`https://域名/api/health` 能访问 |
| T−14 天 | 小程序后端联调完成 |
| T−7 天 | 组织志愿者试跑一次核销流程 |
| T−1 天 | 导出纸质预定名单作为兜底 |

> 备案没下来之前，**服务器可以先用来开发和测试**，不影响进度。所以是并行推进，不是串行等待。

---

## 1. 买什么

### 域名

- `.com` / `.cn`，约 30–60 元/年
- 必须**实名认证**，且持有者要和备案主体一致（个人就是你自己）

### 服务器

- **阿里云 轻量应用服务器，1核2G**（在校生先看高校计划，可能免费或超低价）
- 必须选**国内节点**（境外节点不能备案）
- 绝大多数厂商要求**购买时长 ≥ 3 个月**才发备案服务码，具体看购买页说明

### 明确不要买的

| 不要买 | 原因 |
| --- | --- |
| 云数据库 RDS | SQLite 完全够用，这是最容易被多花的一笔钱 |
| SSL 证书 | Let's Encrypt 免费，certbot 自动续期 |
| ECS / CVM 云服务器 | 比轻量应用服务器贵，你不需要 |
| CDN | 校园量级用不上 |

---

## 2. 备案（两套，可以并行）

这一点很多人搞混：**小程序备案和域名备案是两回事，两个都要做。**

| | 在哪办 | 需要什么 | 什么时候必须做 |
| --- | --- | --- | --- |
| **小程序备案** | 微信公众平台 | 主体信息、负责人信息 | **无论选云开发还是自建，发布前都必须做** |
| **域名备案** | 阿里云控制台 | 域名实名 + 国内服务器 | 只有自建后端才需要 |

因为小程序备案本来就要做，自建额外增加的只是域名备案这一套。

**几个容易踩的坑：**

- 备案绑在服务器上 —— **服务器过期不续，备案会被注销**
- 备案期间网站不能对外提供访问（可以先不解析域名）
- 各省管局审核速度不同，1–3 周是常见区间

### 网站名称

备案表单里的**网站名称**填：**檐下猫小记**

个人备案对这个名称有硬性要求。`校园流浪猫救助` 就是同时踩了两条被驳回的：

| 不许出现 | 原因 |
| --- | --- |
| 地区名（内蒙古、北京…），以及 校园 / 大学 / 学院 | 会被当成机构或地方站点，与个人主体不符 |
| 公益 / 慈善 / 募捐 / 捐款 / 救助 / 志愿者 / 协会 | 个人不得以公益或组织名义运营；涉公开募捐要《慈善法》资质 |
| 公司 / 企业 / 集团 / 工作室 / 传媒 / 商城 / 网 | 会被认定为经营主体或行业站点 |
| 真人姓名 | 个人备案同样不接受 |

反过来，**名称里必须能看出个人属性** —— `小记` `手记` `笔记` `记录` 这类体裁词是通过率最高的一类。
`檐下猫小记` = 意境词（檐下）+ 内容（猫）+ 个人体裁词（小记），三样都占。

`deploy/www/index.html` 的 `<title>`、`<h1>` 和本文档三处必须**逐字一致**，
`tests/deploy.test.mjs` 会强制这一点：改名时漏改一处就会红。

首页**正文**口径同样受约束，这几点比名字更容易成为下次驳回的理由：

- 不要出现学校或机构字样（如「内蒙古师范大学」）—— 会被看成机构站点
- 不要写「义卖所得用于流浪猫的医疗与绝育」这类话 —— 等于以公益名义募集资金
- 不要用「我们是一群…自发组织」这种组织口吻，用第一人称「我」
- 「义卖」这类词在首页压成「闲置物品登记」，避免被当成经营性网站

### 备案备注

备注（网站简介）填：

> 个人网站。用于记录我自己拍摄的猫咪照片和日常观察笔记，纯属个人兴趣，不涉及经营性内容。

规则和名称一致：用第一人称，**不能出现组织、公益、经营三类色彩**。
被驳回的原句「内蒙古师范大学在校学生自发组织的校园流浪猫救助项目」一句话踩了三个点：
内蒙古师范大学（机构）、自发组织（组织）、救助项目（公益 + 项目化）。

更关键的是：**备注必须和管局打开域名时看到的内容相符。**
所以首页也按这个口径收了一遍 —— 去掉机构字样、把「义卖」压成「闲置物品登记」。
只改备注不改首页，就会构成「备注与内容不符」。
`tests/deploy.test.mjs` 会同时校验备注文本和首页，回退会红。

备注里也不要写「预定 / 核销 / 取货码」这类小程序功能词 ——
网站备案描述的是**这个域名上的网站**，小程序是另一套备案，混在一起只会给审核留问句。

### 内蒙古管局的额外要求

来源：腾讯云《内蒙古管局备案要求》（2025-07 更新）。各省细则不同，阿里云控制台的口径以实际为准。

| 要求 | 状态 |
| --- | --- |
| 负责人需年满 18 周岁 | 已确认 |
| **证件地址必须为本自治区** | **已确认满足**（备案人身份证签发地为内蒙古） |
| 个人网站备注**不少于 30 字**，且须包含承诺语 | ⚠️ 见下方待办 |
| 个人不能选「空间/博客」作为网站服务内容（需前置审批） | 选「其他」即可 |
| 「网站服务内容」选「其他」时，需在备注里说明网站内容 | 已符合 |
| 首次备案、新增网站等需提供**域名证书** | 提交时已提供 |
| **不允许变更主体** | 见下方警告，与全国通用口径不同 |

**待办：备注里的承诺语。** 内蒙古要求个人网站备注必须包含：

> 本网站是个人网站，不含有企业、单位等非个人网站的信息，若在核实中发现网站中含有企业、单位等信息，本人愿接受以虚假信息进行备案，注销网站，并将主体和域名加入黑名单的处罚。

我们的备注定稿（约 40 字）目前只含了「不含有企业、单位等非个人主体信息」这个核心声明。
**照阿里云控制台给的模板复制最稳**，手抄容易漏字；控制台没要求就不用加。

> ⚠️ **「不允许变更主体」与全国通用口径不同，别照通用文档办事。**
> 腾讯云通用 FAQ 写的是「个人主体可变更为企业主体，请根据各省管局要求执行」，
> 而内蒙古的个人备案明确写「不允许变更主体」。
> 将来要把网站做成组织官网，**内蒙古这边只能注销原备案、以新主体重新备案**
> （期间网站无法访问），走不了变更备案那条不断网的路。

---

## 3. 服务器初始化

```bash
# 以 root 执行一次即可
sudo bash /srv/bazaar/app/deploy/bootstrap.sh
```

它会做：装 Node.js 22 + nginx + certbot、建 `bazaar` 用户、建目录、开防火墙、安装 systemd 单元。

脚本是**幂等**的，重跑不会坏。

---

## 4. 申请 HTTPS 证书

备案通过、域名解析生效之后：

```bash
sudo certbot --nginx -d 你的域名
```

certbot 会自动改好 nginx 配置并装上续期定时任务。验证续期：

```bash
sudo certbot renew --dry-run
```

---

## 5. 发布

### 先解决：服务器怎么拉代码

如果仓库是**私有**的，`git clone` 会要求认证。三种做法，按省事程度排：

**① 仓库改成公开**（最省事）

代码里没有任何密钥（`SESSION_SECRET` 和 `AppSecret` 都是部署时在服务器上生成的，不进 git），改成 public 之后：

```bash
sudo -u bazaar git clone https://github.com/<你>/IMNU.git /srv/bazaar/app
```

**② Deploy Key**（最规范，推荐长期用）

```bash
# 在服务器上生成一对只用于拉代码的密钥
sudo -u bazaar mkdir -p /srv/bazaar/.ssh
sudo -u bazaar ssh-keygen -t ed25519 -f /srv/bazaar/.ssh/id_ed25519 -N "" -C "bazaar@server"

# 打印公钥，粘到 GitHub 仓库 → Settings → Deploy keys（只读权限就够）
sudo cat /srv/bazaar/.ssh/id_ed25519.pub

# 用 SSH 拉
sudo -u bazaar git clone git@github.com:<你>/IMNU.git /srv/bazaar/app
```

> 有些服务器封了出站 22 端口。连不上就把 remote 改成 `ssh://git@ssh.github.com:443/<你>/IMNU.git`。

**③ Personal Access Token**

```bash
sudo -u bazaar git clone https://<token>@github.com/<你>/IMNU.git /srv/bazaar/app
```

> ⚠️ token 会明文留在 `.git/config` 里。要用这条路，记得给 token 只勾 `repo` 读权限，并且**换人时记得吊销**。

### ⚠️ 服务器连不上 github.com（国内 ECS 很常见，实际踩过）

症状：

```
fatal: unable to access 'https://github.com/yunbozero/IMNU.git/':
Failed to connect to github.com port 443 after 133919 ms: Could not connect to server
```

**等了两分钟才失败 = TCP 连接根本建不起来**。不是认证问题、不是仓库权限、
更不是代码问题。

### ★ 先查代理 —— 如果「之前一直能拉」，几乎就是这个

国内 ECS 直连 github.com 基本不通，能拉通常是**挂了代理**。所以「昨天还好好的，
今天不行了」最可能就是代理掉了。这里有一个非常隐蔽的坑：

> **`sudo` 默认会清掉环境变量。**
> 你在自己 shell 里 `export https_proxy=...`，然后 `sudo bash deploy/deploy.sh` ——
> **那个变量传不进脚本**，因为 `deploy.sh` 是以 root 跑 `git` 的。
> 于是现象就是「我明明挂着代理，git 还是连不上」。

先确认 root 到底有没有代理：

```bash
sudo env | grep -i proxy                       # root 的环境里有没有
sudo git config --global --get http.proxy      # 或者配在 git 里（与 shell 无关）
```

两种干净的做法（选一个，别只在交互 shell 里 export）：

```bash
# ① 保留环境变量 —— 适合临时用
sudo -E bash /srv/bazaar/app/deploy/deploy.sh

# ② 直接配到 root 的 git 里 —— 推荐，换终端、重连 SSH 都还在
sudo git config --global http.proxy http://127.0.0.1:<你的代理端口>
sudo git config --global https.proxy http://127.0.0.1:<你的代理端口>
```

配完**先单独验一次，再发布**：

```bash
sudo git -C /srv/bazaar/app ls-remote origin main
```

> 代理服务本身要能开机自启、断了自动重连，否则每次重启服务器都会重演这一幕。

### 没有代理时的三条出路

```bash
curl -sS -m 8 -o /dev/null -w 'github       -> %{http_code}\n' https://github.com
timeout 8 bash -c 'cat < /dev/null > /dev/tcp/ssh.github.com/443' \
  && echo 'ssh.github.com:443 通' || echo 'ssh.github.com:443 也不通'
```

`ssh.github.com` 和 `github.com` 是**不同的主机名**，前者常常能通 ——
所以第二条的结果比第一条更关键。

**① 能通 `ssh.github.com:443`** → 换成 SSH over 443，最省事：

```bash
cd /srv/bazaar/app
sudo git remote set-url origin ssh://git@ssh.github.com:443/<你>/IMNU.git
```

还需要一把只读 deploy key（见上面 ②，`bootstrap.sh` 会生成到
`/srv/bazaar/.ssh/id_ed25519`）。**`deploy.sh` 会自动用这把钥匙** ——
发布脚本是以 root 跑的，不显式指定的话 SSH 会去翻 `/root/.ssh`，那里没有钥匙，
报错是 `Permission denied (publickey)`，完全看不出「钥匙其实有，
只是挂在另一个账号的家目录下」。

**② 两个都不通** → 换国内能连的镜像，长期就这么用：

- **阿里云 Codeup**（和 ECS 同一朵云，最快最稳，推荐）
- **Gitee**（建一个私有镜像仓库）

把代码推一份过去，然后：

```bash
sudo git remote set-url origin <镜像地址>
```

之后服务器从镜像拉，你往两个远端推（或给 GitHub 配 webhook 自动同步）。

**③ 应急（今天就要发）** → 不拉代码，从本机把当前提交打包送上去：

```bash
# 本地
git archive --format=tar.gz -o imnu.tar.gz HEAD
scp imnu.tar.gz root@<服务器IP>:/tmp/

# 服务器
cd /srv/bazaar/app
sudo tar xzf /tmp/imnu.tar.gz
sudo chown -R bazaar:bazaar /srv/bazaar/app
# ★ 这条路**跳过了测试闸门和首页安装**，两件事必须手工补：
node tests/all.mjs                                            # 测试自己先跑过
sudo install -m 644 deploy/www/index.html /srv/bazaar/www/index.html
sudo systemctl restart bazaar
curl -s http://127.0.0.1:3000/api/health
```

> `deploy.sh` 现在给 `git fetch` 加了超时并且禁止交互，所以**不会再卡两分钟**：
> 最多二十来秒就会带着上面这几条提示失败，并明确说明「线上没有被动过」。

### 之后每次发布

本地 `git push`，然后在服务器上：

```bash
sudo bash /srv/bazaar/app/deploy/deploy.sh
```

脚本会 `git fetch` + `reset`、跑一遍测试、更新首页、再重启服务。**测试不过就不重启** —— 避免把线上搞挂。

> ⚠️ 改首页文案（比如网站名称、备案口径）时注意：**nginx 不读仓库**，它读的是
> `/srv/bazaar/www/index.html` 这个副本。所以只 `git pull` 是不够的，必须重新装一次 ——
> `deploy.sh` 会做这件事，但如果你手动 pull，记得补一句：
>
> ```bash
> sudo install -m 644 /srv/bazaar/app/deploy/www/index.html /srv/bazaar/www/index.html
> ```
>
> 这个坑很安静：不报错，只是线上一直显示旧文案。改网站名称那次就踩了。

> ⚠️ 如果以 root 跑 git 报 `fatal: detected dubious ownership in repository at '/srv/bazaar/app'`：
> 这是 `deploy.sh` 第 1 步结尾把仓库 `chown` 给服务账号 `bazaar` 造成的 ——
> 仓库属主从此不等于执行者（root）。**它会让旧版脚本跑不了第二遍**，
> 现象是「发布没效果」，很容易误判成网络或代理问题。
> 新版脚本自己会加 `safe.directory` 例外；遇到旧版或手动操作时，先跑一次：
>
> ```bash
> sudo git config --global --add safe.directory /srv/bazaar/app
> ```

---

## 5.5 第一次部署后必须做的三件事

**不做这一步，服务能跑但没人能当管理员，换届转交的承诺就是空的。**

### ① 填小程序密钥

**不填的后果，值得说清楚**：服务照常启动、首页能访问、物品列表和猫猫图鉴都正常，
**只有登录一个人都过不去** —— 因为浏览类接口是公开的，需要身份的接口才走登录。
在小程序里的表现是「**填了昵称点提交没反应 / 提示登录失败**」，
看着像网络问题或前端 bug，很容易往错的方向查半天。

```bash
sudo nano /etc/bazaar/env
```

**nano 的存盘按键**（屏幕底部的 `^O` 里的 `^` 是 **Ctrl** 键，不是先按 shift+6）：

| 想干什么 | 按键 |
| --- | --- |
| 保存 | `Ctrl+O` → 底部出现 `File Name to Write: /etc/bazaar/env` → **回车** |
| 保存并退出 | `Ctrl+X` → 问 `Save modified buffer?` → 按 **`Y`** → **回车** |
| 不保存退出 | `Ctrl+X` → 按 `N` |

> ⚠️ **不要按 `Ctrl+S`。** 在终端里 `Ctrl+S` 是「暂停输出」（XOFF），
> 屏幕会像死了一样毫无反应，你会以为 nano 卡了。
> 真按了就按 **`Ctrl+Q`** 恢复。这个坑对用惯图形编辑器的人特别常见。

填上小程序后台「开发管理 → 开发设置」里的 **AppID** 和 **AppSecret**：

```
WX_APPID=wx..........          ← 必须和 miniprogram/project.private.config.json 里那个一致
WX_SECRET=...................  ← AppSecret
```

**格式要求**（`EnvironmentFile` 不是 shell，它比 shell 更死板）：

- **等号两边不要有空格**：`WX_APPID = wx...` 会被当成一个叫 `WX_APPID ` 的变量，等于没填
- **值不要加引号**：引号会连同内容一起当值
- 一行一项，行首不要有 `#`（那是注释掉）

> **AppSecret 只在公众平台显示一次**，没记下来就要在同一个页面点「重置」
> （重置后旧的立即失效）。它**不要提交进 git、不要贴进聊天窗口、不要写进命令行** ——
> 命令行会进 shell 历史。用编辑器改文件是唯一干净的做法。
> 仓库里有一条密钥扫描测试守着，真提交了会红。

改完重启：

```bash
sudo systemctl restart bazaar
```

**怎么确认填对了**（这几条都不需要看到密钥本身）：

```bash
# 0. 权限要对：bazaar 账号得读得到，别人读不到
ls -l /etc/bazaar/env
#   期望：-rw-r----- 1 root bazaar …
#   ★ 这里有个**静默失败**：systemd 里写的是 EnvironmentFile=-/etc/bazaar/env，
#     开头那个 - 表示「读不到也不报错」。所以权限一旦变成 600 且属主是 root，
#     文件内容就完全没进到服务里，而服务照常启动、不报任何错 ——
#     症状和「压根没填」一模一样。修：
#     sudo chmod 640 /etc/bazaar/env && sudo chown root:bazaar /etc/bazaar/env

# 1. 值填进去了没有。AppID 固定 18 位（wx + 16 位），AppSecret 固定 32 位；
#    长度不对说明等号边上多了空格、或者把引号也一起粘进去了
sudo awk -F= '/^(WX_APPID|WX_SECRET)=/{printf "%s 长度=%d\n", $1, length($2)}' /etc/bazaar/env

# 2. 启动警告应该消失（没填时会打「未配置 WX_APPID / WX_SECRET」）
sudo journalctl -u bazaar -n 30 --no-pager | grep 密钥

# 3. 部署过带诊断的版本之后，健康检查会直接说
curl -s https://你的域名/api/health      # {"ok":true,...,"wxConfigured":true}
```

> 第 2 条如果**警告还在**，只有两种可能：文件没存到你以为的那个路径
> （`Ctrl+O` 时底部会显示完整路径，对一下），或者第 0 条的权限被改坏了。

> `SESSION_SECRET` 是 `bootstrap.sh` 自动生成的随机值，**不要动它** —— 改了所有人都会掉登录。

同一个文件里还有几个可调项（都有默认值，不填也能跑）：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `MAX_ITEMS_PER_USER` | `3` | 每个账号在本次活动内最多预定几件。**防囤货的软上限**，`0` 表示不限 |
| `WX_APPID` / `WX_SECRET` | 无 | 不填则登录接口直接失败 |
| `PORT` / `DB_PATH` | `3000` / `/srv/bazaar/data/bazaar.db` | 一般不用改，改之前先看 `deploy/bazaar.service` |

改完都要 `sudo systemctl restart bazaar`。

> **`MAX_ITEMS_PER_USER` 现在只是「默认值」。** 管理员可以在小程序里改这个上限
> （管理端 · 预定名单页顶部，一级管理员及以上），**改完下一笔预定就生效，不用重启**。
> 一旦有人改过，数据库里的值就压过环境变量；界面上的「恢复默认」会把它删掉、回落到这里。
> 所以**义卖当天不用为了调上限去动服务器** —— 这是个降级路径，只在设置被改坏时才需要。

### ② 设立第一个超管

转交要求「已经有一个超管」，而接口又拒绝直接设 owner，所以第一个超管只能由服务端设立：

```bash
# 先让一个人在小程序里完成登记（填个昵称即可），然后列出已登记的人
sudo -u bazaar DB_PATH=/srv/bazaar/data/bazaar.db \
  node /srv/bazaar/app/scripts/set-owner.mjs --list

# 从列表里找到你的 openid，设成超管
sudo -u bazaar DB_PATH=/srv/bazaar/data/bazaar.db \
  node /srv/bazaar/app/scripts/set-owner.mjs <你的openid>
```

之后**不要再跑这个脚本**。换届时让现任超管在小程序里走「转交超管」。

> ★ **开发者工具里的 openid 和手机上的不是一回事。**
> 开发者工具里 `wx.login` 给的是随机 code，每次清缓存都换一个假身份，而且它连的是
> `127.0.0.1:3000`（本机库）；真人从「**预览 / 体验版 / 正式版**」进小程序时拿的是
> **真实 openid**，落在**线上库**里。
> 所以要给手机上那个账号提权，必须对着**线上库**跑脚本，并用 `--list`
> 按**昵称**认出是哪一行。

### ②.5 给其他人开权限（志愿者 / 副管理员）

**小程序里没有任命角色的界面**（接口 `POST /api/admin/role` 早就有，界面一直没做），
而 `set-owner.mjs` 只在「一个超管都没有」时生效一次。所以义卖当天给几个志愿者
开核销权限，走这个脚本：

```bash
# 列出现在都有谁、分别是什么角色
sudo -u bazaar DB_PATH=/srv/bazaar/data/bazaar.db \
  node /srv/bazaar/app/scripts/set-role.mjs --list

# 把某人设成志愿者（能进核销台）
sudo -u bazaar DB_PATH=/srv/bazaar/data/bazaar.db \
  node /srv/bazaar/app/scripts/set-role.mjs <openid> volunteer

# 二级管理员（还能看名单、取消别人的预定、加减物品名额）
#   …… <openid> deputy
# 一级管理员（再加上撤销误核销、改每账号上限）
#   …… <openid> admin
```

| 角色 | 能干什么 |
| --- | --- |
| `student` | 只能预定 |
| `volunteer` | + 核销台（扫码/输码核销） |
| `deputy` | + 预定名单、取消别人的预定、物品名额与上下架、新建物品 |
| `admin` | + 撤销误核销、改「每账号最多预定几件」 |
| `owner` | + 转交超管（**不能**用这个脚本设） |

两条刻意的限制：

- **不能在这里设超管** —— 超管只能由 `set-owner.mjs` 设立一次，之后走「转交超管」。
- **不能改现任超管的角色** —— 从接口走有 `roles.mjs` 的策略挡着，而脚本是直接调数据层的。
  真把超管降级会变成「零个超管」，接口再也转交不了，只能重跑 `set-owner`。

改完之后，**那个人要重新进一次「我的」页**才会看到新入口 ——
那一页每次显示都会拉一次最新角色，不用清缓存、不用重新登记。


### ③ 确认小程序里的后端地址

`miniprogram/config.js` 里的 `PROD_BASE` 应当就是 nginx 的域名：

```js
const PROD_BASE = 'https://neishidemao.cn';
```

`tests/deploy.test.mjs` 会校验它和 `deploy/nginx.conf` 的 `server_name` 对得上，换域名时两边一起改。

> 地址是按**跑在哪儿**选的，不是按版本：只有开发者工具（`platform === 'devtools'`）才回落
> `http://127.0.0.1:3000`，真机预览和体验版一律走线上。
> **别改回按 `envVersion` 判断** —— 那样真机会拿到 `127.0.0.1`（手机自己），
> 所有请求静默失败，现象看起来是「后端挂了」。

---

## 5.6 备案号已挂在页脚（已做）

《非经营性互联网信息服务备案管理办法》第十三条要求在主页底部标明备案编号，并链接工信部备案系统。
管局和接入商会抽查这一条。

**已填：`蒙ICP备2026010486号-1`**（2026-09 域名备案通过），写在 `deploy/www/index.html` 页脚的
`.icp` 那行，链接指向 `https://beian.miit.gov.cn/`。

> **主体备案号 vs 网站备案号**：`蒙ICP备2026010486号` 是**主体号**（标识"你这个人"），
> 末尾的 `-1` 是**网站序号**（标识"该主体下的第 1 个网站"）。页面上两者都可以放，
> 但**以工信部备案系统里查到的「网站备案号」为准**最稳 ——
> 打开 <https://beian.miit.gov.cn> 输入域名就能查到，那不是猜的。

以后如果要换（换域名、换主体）：

1. **在本地改**，不要只改服务器 —— `deploy.sh` 会 `git reset --hard`，服务器上的手改会被冲掉。
2. 提交推送，然后在服务器上跑：

   ```bash
   sudo bash /srv/bazaar/app/deploy/deploy.sh
   ```

3. 验证：

   ```bash
   curl -s -H 'Host: neishidemao.cn' http://127.0.0.1/ | grep -o '蒙ICP备[^<]*'
   ```

`tests/deploy.test.mjs` 挡住链接被删、以及备案号被编造（占位符或真号都认，`XXXX`/一串 0 不认）。

> ⚠️ **还有一套：公安联网备案。** 网站对外开通后 **30 日内**要到公安机关办理
> （《计算机信息网络国际联网安全保护管理办法》），公网安备号同样要挂在页脚，
> 链接到 `beian.mps.gov.cn`。这一套和 ICP 是两回事，别以为 ICP 过了就完事。

### 公网安备（页脚位置已预留，等号）

页脚已经放好位置了，现在是占位符 `公网安备 待备案`：

```html
<div class="icp">
  <a href="https://beian.mps.gov.cn/" target="_blank" rel="noopener">公网安备 待备案</a>
</div>
```

**30 天从「网站对外可访问」起算** —— 也就是域名解析生效、外面能打开的那天，
不是拿到 ICP 号的那天。

拿到号之后（在**仓库里**改，别只改服务器）：

1. 把 `待备案` 换成 `蒙公网安备` + 编号 + `号`。
2. 把 `href` 换成查询链接：
   `https://beian.mps.gov.cn/#/query/webSearch?code=<备案编号>`
   （点进去要能查到你的备案信息，只放个首页链接是不合格的）
3. 提交推送 → 服务器上 `sudo bash /srv/bazaar/app/deploy/deploy.sh`

`deploy.sh` 每次发布会提醒「占位符还在」，所以不会忘。
`tests/deploy.test.mjs` 挡住链接被删或编号被编造。

> **一个容易踩的坑：** 公网安备编号是十几位数字。`tests/secrets.test.mjs` 有一条
> 「手机号」规则，要求**正好 11 位**且两侧没有数字。十几位的编号不会被命中，
> 但如果哪天出现「填写公网安备号之后密钥扫描报手机号」的情况，原因就是这个 ——
> 不是真的泄了手机号。

---

## 5.7 建活动、摊位和物品（真机预览之前必须做）

**不做这一步，小程序打开就是「活动还没开始」** —— 线上库是空的，而且管理端界面
只能**改**物品、**新建**物品，活动和摊位没有任何界面入口。

```bash
# 1. 写一份配置，放到仓库外面（deploy.sh 会 git reset --hard，放仓库里会被冲掉）
sudo nano /srv/bazaar/event.json          # 照抄 deploy/event-config.example.json 改

# 2. 先只看计划 —— 不带 --yes 时一个字节都不写，连库文件都不会建
sudo -u bazaar DB_PATH=/srv/bazaar/data/bazaar.db \
  node /srv/bazaar/app/scripts/init-event.mjs /srv/bazaar/event.json

# 3. 计划没问题再真的写
sudo -u bazaar DB_PATH=/srv/bazaar/data/bazaar.db \
  node /srv/bazaar/app/scripts/init-event.mjs /srv/bazaar/event.json --yes
```

几个要知道的点：

- **必须用 `sudo -u bazaar`**。用 root 跑会写出 root 属主的 `-wal` / `-shm` 文件，
  服务（`bazaar`）之后写不进去，症状是「核销时好时坏」，报错完全指不到权限上。
- **可以重复运行**：活动/摊位/物品按名字查重，已有的跳过。所以义卖当天要补几件，
  就在 `items` 里追加几行再跑一次 `--yes`。
- **活动时间写北京时间**（`"startsAt": "2026-04-18 09:00"`）。脚本内部按 `+08:00` 解析 ——
  服务器多半是 UTC，直接 `new Date(...)` 会让首页那行差 8 小时。
- 脚本会**提醒但不拦**「库里已经有别的在售活动」。首页只认最新建的那个，
  所以真出现这种情况要处理掉旧的那个（改 `events` 表的 `status`）。
- 加物品之后**不用重启服务**，小程序下拉刷新就能看到。

> 后面日常加物品用管理端界面（「我的」→ 管理端 → 物品名额 → ＋新建物品）就够了，
> 不必每次上服务器。这个脚本只在**开新活动**和**批量录入**时才需要。

### 物品照片

照片存在 `/srv/bazaar/images/`，**nginx 直接发文件**（不走 Node）。

> ⚠️ **这一段 nginx 配置必须人工合并，不会自动生效。**
> `certbot --nginx` 把证书和 443 的 server 块**直接写进了**
> `/etc/nginx/sites-available/bazaar`，而 `bootstrap.sh` 检测到 `ssl_certificate`
> 就会**跳过**安装仓库里的 `nginx.conf`（否则会把 HTTPS 配置一起抹掉，网站当场变砖）。
> `deploy.sh` 也不会去碰它。
>
> 所以仓库里新增的 `location /images/` 到不了线上，后果是：
> **nginx 的 `location /` 会先把 `/images/...` 接走**，去 `/srv/bazaar/www` 找文件，
> **线上物品照片全部 404** —— 而本地和自动化测试里一切正常，Node 那个处理器根本轮不到。
>
> 合并方法：把 `deploy/nginx.conf` 里的 `location /images/ { … }` 整段
> 贴进 `/etc/nginx/sites-available/bazaar`（放在 `location /api/` 旁边就行），然后
> ```bash
> sudo nginx -t && sudo systemctl reload nginx
> ```
> `deploy.sh` 每次发布都会检查这一段在不在，缺了就警告，所以不会忘。

`deploy.sh` 会自己把照片目录补上（`install -d`，幂等）。发布完确认一下权限：

```bash
ls -ld /srv/bazaar/images
# 期望：drwxr-xr-x … bazaar bazaar … /srv/bazaar/images
```

**真正能判定「照片这条路通了没有」的只有一种测法：放一个真文件进去取一次。**

```bash
# 用 bazaar 账号建文件 —— 这才是服务写照片时的真实身份
sudo install -d -m 755 -o bazaar -g bazaar /srv/bazaar/images
sudo -u bazaar sh -c 'printf "\211PNG\r\n\032\n" > /srv/bazaar/images/probe.png'

curl -sI https://你的域名/images/probe.png | head -3
# 期望：HTTP/2 200 且 content-type: image/png
#   → 说明 location /images/ 生效了、nginx 也读得到这个目录

sudo rm -f /srv/bazaar/images/probe.png
```

> ⚠️ **不要用 `curl -sI .../images/`（只到目录）来判断。**
> 那个结果同时取决于三件事：目录存不存在、`index` 有没有命中、请求落在哪个
> `server` 块 —— 它返回 404 完全可能是「目录还没建」而不是「配置没生效」。
> 我就是拿这个当判据，白让人查了一轮。用上面那个放真文件的测法，一次就能定下来。

如果放了文件仍然 404，按顺序排：

1. **配置没加载**：`sudo nginx -T | grep -c 'location /images/'`，是 `0` 就说明没生效
   （改完必须 `sudo nginx -t && sudo systemctl reload nginx`）。
2. **加错了 server 块**：`certbot --nginx` 通常会**新加**一个 `listen 443 ssl` 的块，
   而 https 请求走的是那一个。`location /images/` 必须和 `listen 443` 在**同一个**
   `server { }` 里 —— 加在 `listen 80` 那个块里对 https 没用。
   用 `sudo grep -n 'listen\|location /images/' /etc/nginx/sites-available/bazaar`
   看行号就能对出来。
3. **权限**：目录不是 755，或属主不是 `bazaar`（nginx 的 worker 是 `www-data`）。

> ⚠️ **不要**为了照片去配「downloadFile 合法域名」。
> `<image>` 组件的 `src` **不受服务器域名白名单限制**（白名单管的是 `wx.request` /
> `wx.uploadFile` / `wx.downloadFile` / `wx.connectSocket` 这几个 **API**，
> `<image>` 是个**组件**）。这条本项目一次都没用到 `wx.downloadFile`。
> 官方 [image 组件文档](https://developers.weixin.qq.com/miniprogram/dev/component/image.html)
> 里也没有白名单这一项。真机上图片不显示，先查**是不是 HTTPS**（微信不接受 http 图片）
> 和服务器通不通，而不是去加域名 —— 加错了方向会白折腾。

几个要知道的点：

- **`ReadWritePaths` 里有照片目录**（`deploy/bazaar.service`）。`ProtectSystem=strict`
  会把整个文件系统挂成只读，漏了它的话传图会报 `EROFS`——而本地没有 systemd 加固，
  **怎么测都是正常的**。`deploy.sh` 现在会同步 unit 文件并 `daemon-reload`，
  所以改了这一行也能随发布生效。
- **照片不进备份**。`bazaar-backup` 只管数据库 —— 图片丢了重新传一遍就行，
  为它把备份脚本改复杂不值得。
- **照片目录不能是 750**。那是数据目录的权限；nginx 的 worker 跑在 `www-data` 下，
  750 的话它连目录都进不去，图片全变 404，而服务端日志一切正常。
- 义卖当天要临时加带图的物品，直接在管理端点「＋新建物品」选图即可，不用上服务器。

---

## 6. 验收清单

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| 服务在跑 | `systemctl status bazaar` | `active (running)` |
| 开机自启 | `systemctl is-enabled bazaar` | `enabled` |
| 接口通 | `curl -s https://你的域名/api/health` | `{"ok":true,...}` |
| **首页能访问** | `curl -sI https://你的域名/` | `200`，**不能是 404**（见下） |
| 证书有效 | `echo \| openssl s_client -connect 你的域名:443 2>/dev/null \| openssl x509 -noout -dates` | 未过期 |
| 续期可用 | `sudo certbot renew --dry-run` | 成功 |
| 数据库在 | `ls -l /srv/bazaar/data/` | 有 `.db` 文件 |
| **备份在跑** | `systemctl list-timers bazaar-backup.timer` | 有 `NEXT` 时间 |
| **备份可用** | `sudo systemctl start bazaar-backup && sudo -u bazaar node /srv/bazaar/app/server/backup.mjs list` | 列表里有今天的一份 |
| 端口没裸奔 | 阿里云安全组只放 22 / 80 / 443 | 3000 不对外 |

**最后一步**：去微信公众平台 → 开发管理 → 开发设置 → 服务器域名，把 `https://你的域名` 加进 **request 合法域名**。这一步不做，小程序发不出请求。

> 只管 `request` 就够。物品照片走的是 `<image>` 组件，**不受这个白名单限制**（见 §5.7）。

### 为什么根路径必须有一个页面

`/` 返回 404 是会被抓的：**备案通过之后，管局和阿里云会抽查**。如果访问你的域名根路径得到 404，可能被判定为「备案信息与实际提供的服务不符」，**严重的话备案会被注销**。

所以 `bootstrap.sh` 会把 `deploy/www/index.html` 装到 `/srv/bazaar/www/`，nginx 的根路径指向它。页面内容要和备案时填的服务内容对得上。

**要改成自己的网站**，编辑 `/srv/bazaar/www/` 下的文件即可，nginx 不用动。

> 目录权限是特意设成 755 的：nginx 的 worker 跑在 `www-data` 下，**不是** `bazaar` 账号。要是目录跟着数据目录一起收紧成 750，nginx 进不去，表现就是 403。

---

## 7. 上线之后要一直记住的事

- **服务器要续费。** 过期不光服务停，备案也会被注销，重新走一遍很麻烦。
- **证书自动续期。** certbot 装了定时任务，但偶尔看一眼 `certbot renew --dry-run`。
- **换届交接。** 服务器账号、域名账号、备案主体都要能转交。这是自建方案相比云开发最麻烦的一点，**提前把账号信息写在一个社团共用的地方**。

### 备份是自动的，但恢复要会手动做

`bootstrap.sh` 已经装好定时器：**每天 03:30 自动备份，保留最近 14 份**，机器关机错过会在开机后补跑。

但它用的是 SQLite 的 `VACUUM INTO`，**不是 `cp`**。原因值得记住：

> 数据库跑在 WAL 模式下，最近的写入可能还在 `-wal` 文件里没落盘。
> **服务运行中直接 `cp bazaar.db`，拷出来的很可能是缺数据的**——而且它坏得很安静，
> 文件看着好好的，就是少东西。`tests/backup.test.mjs` 里有一条测试专门证明了这件事。

**手动操作：**

```bash
# 看有哪些备份
sudo -u bazaar DB_PATH=/srv/bazaar/data/bazaar.db BACKUP_DIR=/srv/bazaar/backup \
  node /srv/bazaar/app/server/backup.mjs list

# 立刻备一份（义卖当天建议改成每小时备一次）
sudo systemctl start bazaar-backup

# 校验某一份能不能用 —— 备份不校验，等于没有备份
sudo -u bazaar node /srv/bazaar/app/server/backup.mjs verify /srv/bazaar/backup/xxx.db
```

**恢复（出事了才用）：**

```bash
sudo systemctl stop bazaar                       # 1. 必须先停服务
sudo -u bazaar DB_PATH=/srv/bazaar/data/bazaar.db \
  node /srv/bazaar/app/server/backup.mjs restore /srv/bazaar/backup/xxx.db --yes
sudo systemctl start bazaar                      # 2. 再起来
```

恢复脚本会：先校验备份，不合格直接拒绝、**绝不动线上库**；把当前库改名留底而不是删掉；
拷回来之后**清掉旧的 `-wal` / `-shm`**——那是旧库的预写日志，留着会被当成新库的日志去重放，直接把库搞坏。

**义卖当天建议把频率调高。** 编辑 `/etc/systemd/system/bazaar-backup.timer`，把 `OnCalendar` 改成 `*-*-* *:00:00`（每小时），然后：

```bash
sudo systemctl daemon-reload && sudo systemctl restart bazaar-backup.timer
```

活动结束后改回每天一次。

---

## 8. 部署产物的文件分工

| 文件 | 在哪跑 | 干什么 |
| --- | --- | --- |
| `deploy/bootstrap.sh` | 服务器（root，一次） | 装依赖、建用户和目录、装 systemd 单元与备份定时器 |
| `deploy/bazaar.service` | 服务器 | 主服务：进程守护 + 开机自启 |
| `deploy/bazaar-backup.service` | 服务器 | 备份单元（`server/backup.mjs backup`） |
| `deploy/bazaar-backup.timer` | 服务器 | 每天 03:30 触发备份 |
| `deploy/nginx.conf` | 服务器 | 反向代理 |
| `deploy/deploy.sh` | 服务器 | 拉代码、跑测试、**更新首页**、重启 |
| `server/backup.mjs` | 服务器 | 备份 / 校验 / 恢复的实现 |

这些配置里的**路径、端口、用户名必须保持一致**，`tests/deploy.test.mjs` 会盯着这件事——
比如备份单元读的库必须和主服务写的是同一个，`ReadWritePaths` 必须同时放行数据目录和备份目录。
