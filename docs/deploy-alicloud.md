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

---

## 5.5 第一次部署后必须做的三件事

**不做这一步，服务能跑但没人能当管理员，换届转交的承诺就是空的。**

### ① 填小程序密钥

```bash
sudo nano /etc/bazaar/env
```

填上小程序后台「开发管理 → 开发设置」里的 **AppID** 和 **AppSecret**，然后重启：

```bash
sudo systemctl restart bazaar
```

> `SESSION_SECRET` 是 `bootstrap.sh` 自动生成的随机值，**不要动它** —— 改了所有人都会掉登录。

### ② 设立第一个超管

转交要求「已经有一个超管」，而接口又拒绝直接设 owner，所以第一个超管只能由服务端设立：

```bash
# 先让一个人在小程序里完成登记（学号 + 姓名），然后列出已登记的人
sudo -u bazaar DB_PATH=/srv/bazaar/data/bazaar.db \
  node /srv/bazaar/app/scripts/set-owner.mjs --list

# 从列表里找到你的 openid，设成超管
sudo -u bazaar DB_PATH=/srv/bazaar/data/bazaar.db \
  node /srv/bazaar/app/scripts/set-owner.mjs <你的openid>
```

之后**不要再跑这个脚本**。换届时让现任超管在小程序里走「转交超管」。

### ③ 改小程序里的后端地址

`miniprogram/config.js` 里的 `PROD_BASE` 现在是占位域名，必须改成真实域名：

```js
const PROD_BASE = 'https://你的域名';
```

改完要重新上传小程序代码。

> 开发阶段它会自动回落到 `http://127.0.0.1:3000`（靠 `__wxConfig.envVersion` 判断），本地联调不用手改。

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
