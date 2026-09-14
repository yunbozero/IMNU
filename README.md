# IMNU 校园义卖预定小程序

内蒙古师范大学校园义卖活动的**预定名额登记**小程序。

学生浏览义卖物品 → 预定名额 → 获得取货码 → 义卖当天凭码到摊位**线下付款取货**。
小程序不涉及在线支付，只负责锁名额与核销。

> ⚠️ 主体为个人主体小程序，因此**界面内不出现任何价格、金额与线上交易**。这不是取舍，是硬约束，有测试守着。

---

## 当前进度

| 阶段 | 状态 | 产物 |
| --- | --- | --- |
| 前端方案 | ✅ 已评审 | [docs/ui-prototype-plan.md](docs/ui-prototype-plan.md) |
| HTML 可点击原型 | ✅ 已完成 | [prototype/](prototype/README.md) |
| 给组织方的提案（A4 / PDF） | ✅ 已完成 | [docs/proposal.html](docs/proposal.html) |
| 微信长图（学生端 / 管理端） | ✅ 已展示（产物可再生，不入库） | [docs/longimage-student.html](docs/longimage-student.html) · [docs/longimage-admin.html](docs/longimage-admin.html) |
| **阶段 1 · 后端核心**（数据模型 + 防超卖 + 核销） | ✅ 已完成 | [docs/data-model.md](docs/data-model.md) · `server/` |
| **阶段 3 · 后端接口**（鉴权 + HTTP 接口） | ✅ 已完成 | [docs/api.md](docs/api.md) |
| **阶段 2 · 小程序分包骨架** | ✅ 已完成 | `miniprogram/` |
| 阶段 4 · 阿里云部署 | 🔧 脚本已就绪，等域名与备案 | [docs/deploy-alicloud.md](docs/deploy-alicloud.md) · `deploy/` |
| 阶段 5 · 联调与演练 | ⏸ 待启动 | — |
| 阶段 6 · 猫猫图鉴内容填充 | ⏸ 骨架已就位，等真实数据 | `miniprogram/packageCats/` |

### 小程序结构

```
miniprogram/
  app.json / app.js / app.wxss     全局配置与样式（设计语言沿用原型）
  config.js                        换环境只改这一个文件
  data/cats.js                     猫猫图鉴静态数据（必须在主包）
  services/platform.js             把 wx 的能力收在一处 → 可在 Node 里测试
  services/api.js                  接口客户端，翻译 ok:false 约定
  services/session.js              登录、登记、token
  pages/                           主包：首页 / 猫猫图鉴 / 我的
  packageBazaar/                   分包：义卖全部页面
  packageCats/                     分包：图鉴详情与送养
```

**两条微信的硬性规则，已经变成断言：**

- **tabBar 页面必须在主包** —— 所以「猫猫图鉴」的入口页在 `pages/cats`，其余在 `packageCats`
- **主包不能引用分包的文件** —— 所以图鉴数据 `data/cats.js` 放主包（分包引用主包是允许的）

将来要拆成两个小程序，`packageCats/` 整个搬走即可，义卖一行不用改。

### ⏰ 现在就该去启动备案

**备案是 1–3 周的不可压缩等待期，只能等，所以它是整个项目的关键路径。**
今天就去买域名和服务器、提交备案；备案期间服务器照样能用来开发，不影响进度。

采购清单、备案要点、验收步骤都写在 [docs/deploy-alicloud.md](docs/deploy-alicloud.md) 里。

### 后端核心已经证明了什么

`npm test` 里有几项不是"跑一下不报错"，而是真的在验证核心命题：

- **8 线程 × 15 次并发抢 20 份名额 → 恰好卖出 20 份**，失败原因全是「约满」（真多线程，不是假装并发）
- **8 线程抢着核销同一个取货码 → 只有 1 次成功**
- **绕过应用层直接写 SQL 扣名额 → 数据库拒绝，名额不会变负**（第二道防线）
- **随机 400 步操作，每一步后账目都必须平衡**（预定扣、取消还、核销不动）

### 把提案导出成 PDF

用浏览器打开 `docs/proposal.html`，`Ctrl+P` → 目标打印机选「另存为 PDF」→ **记得勾选「背景图形」**，否则彩色块会丢。

### 重新生成长图

```powershell
npm run longimage
```

用无头 Edge/Chrome 把 `docs/longimage-*.html` 渲染成 750px 宽的 PNG。
生成的 PNG 属于**可再生的构建产物，不写进 git**（已在 `.gitignore` 中排除），需要转发时现场生成即可。

---

## 快速开始

```powershell
npm run serve      # 打开 http://localhost:8080/ 看原型演示台
npm test           # 跑全部测试（158 项）
npm start          # 起后端接口（需要 SESSION_SECRET 环境变量）
npm run longimage  # 重新生成微信长图（产物不入库）
```

需要 **Node 22+**（后端用了内置的 `node:sqlite`）。全仓库零第三方依赖。

### 本地起后端

```powershell
$env:SESSION_SECRET = (openssl rand -hex 32)   # 或随便一个 16 位以上的字符串
$env:DB_PATH = ".\tmp\bazaar.db"
$env:PORT = "3000"
npm start
```

不配 `WX_APPID` / `WX_SECRET` 也能起，只是 `/api/login` 会失败——其余接口照常。

---

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `prototype/` | 可点击 HTML 原型（学生端 + 志愿者核销端） |
| `server/` | 后端：数据模型与 repository（SQLite 实现） |
| `docs/` | 设计方案、数据模型、提案、长图源文件 |
| `tests/` | 全部测试：合规红线、结构、状态机、**并发与不变量** |
| `scripts/` | 本地静态服务器、长图渲染 |

---

## 相关约定

协作约定见 [AGENTS.md](AGENTS.md)：每次改动都要配套测试并创建 commit。
