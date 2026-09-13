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
| 后端与云开发设计 | ⏸ 待启动（等与义卖组织方谈定方案） | — |

### 把提案导出成 PDF

用浏览器打开 `docs/proposal.html`，`Ctrl+P` → 目标打印机选「另存为 PDF」→ **记得勾选「背景图形」**，否则彩色块会丢。

---

## 快速开始

```powershell
npm run serve     # 打开 http://localhost:8080/ 看原型演示台
npm test          # 跑合规 / 结构 / 状态机测试
```

需要 Node 18+。原型是纯静态的，没有任何第三方依赖。

---

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `prototype/` | 可点击 HTML 原型（学生端 + 志愿者核销端） |
| `docs/` | 设计方案与决策记录 |
| `tests/` | 原型验证：合规红线、结构完整性、状态机逻辑 |
| `scripts/serve.mjs` | 零依赖本地静态服务器 |

---

## 相关约定

协作约定见 [AGENTS.md](AGENTS.md)：每次改动都要配套测试并创建 commit。
