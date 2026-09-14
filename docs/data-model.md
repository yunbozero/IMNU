# 数据模型

> 状态：已实现并通过测试（`server/db.mjs` · `server/repository.mjs`）
> 实现方式：SQLite（Node 内置 `node:sqlite`，零第三方依赖）

---

## 1. 设计原则

1. **一切挂在「场次」下。** 义卖是周期性活动，所有数据都带 `event_id`。第二次办活动不用清库，建个新 event 就行。
2. **没有金额字段，一个都没有。** 个人主体小程序的硬约束，由测试守着。
3. **名额有且只有一个地方被扣减** —— `tryReserve()`。别的任何代码都不许碰 `remaining_quota`。
4. **防超卖靠两层独立防线**，而不是靠"小心写代码"：
   - 应用层：带条件的原子 UPDATE，检查影响行数是否为 1
   - 数据库层：`CHECK (remaining_quota >= 0)`
5. **可迁移优先于性能。** 用到的 SQL 特性（唯一索引、条件更新、事务）在 SQLite / MySQL / 云数据库上语义一致。

---

## 2. 表结构

### users — 用户

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `openid` | 微信 openid，**唯一** |
| `sid` | 学号，**唯一**，可为 NULL |
| `name` | 姓名 |
| `role` | `student` / `volunteer` / `admin` / `owner` |

### events / stalls — 场次与摊位

| 表 | 关键字段 |
| --- | --- |
| `events` | `name`、`starts_at`、`ends_at`、`status`(`draft`/`on_sale`/`ended`) |
| `stalls` | `event_id`、`name`、`loc` |

### items — 义卖物品

| 字段 | 说明 |
| --- | --- |
| `event_id` / `stall_id` | 归属 |
| `total_quota` | 总名额 |
| `remaining_quota` | 剩余名额，**有 CHECK 约束保证非负** |
| `status` | `on_sale` / `off_shelf` |

### reservations — 预定

| 字段 | 说明 |
| --- | --- |
| `event_id` / `item_id` / `user_id` | 归属 |
| `qty` | 数量，`CHECK (qty > 0)` |
| `code` | 6 位取货码 |
| `status` | `reserved` / `redeemed` / `cancelled` |
| `request_id` | **幂等键**，客户端生成 |
| `active_key` | 见第 3 节 |
| `redeemed_at` / `operator_id` | 核销时间与经手志愿者 |

### audit_logs — 审计

`actor_id`、`action`、`target_type`、`target_id`、`detail`、`created_at`。
MVP 阶段只写不读，但**必须有** —— 换届纠纷时这是唯一凭据。

---

## 3. 四个唯一索引

这是整套设计里最关键的四个约束。**它们由数据库强制执行，不依赖应用代码对不对。**

| 索引 | 作用 | 挡住什么 |
| --- | --- | --- |
| `users.openid` | 一个微信号只能登记一次 | 一个人开小号刷名额 |
| `users.sid` | 一个学号只能登记一次 | 两个微信号填同一个学号 |
| `reservations.request_id` | 同一个请求只受理一次 | 网络重试 / 手抖连点产生重复单 |
| `reservations.(event_id, code)` | 取货码在场次内唯一 | 撞码导致两个人用同一个码取货 |

### `active_key` 那个小技巧

需求是：**同一件物品每人只能有一笔待取货预定，但取消之后要允许重新预定。**

直接用 `UNIQUE(event_id, item_id, user_id)` 是不行的——取消之后那笔记录还在，人就永远不能再预定了。

解法是加一个 `active_key` 字段：

- 待取货时：`active_key = "eventId:itemId:userId"`
- 取消或核销后：`active_key = NULL`

`UNIQUE(active_key)` 生效，而**唯一索引允许多个 NULL 并存**（SQLite / MySQL / PostgreSQL 行为一致）。所以一笔历史记录不挡路，但活跃的重复预定会被数据库直接拒绝。

比起"先查有没有、没有再插入"，这个做法在并发下才是对的。

---

## 4. 必须永远成立的不变量

```
①  remaining_quota >= 0
②  remaining_quota + Σ(qty where status ∈ {reserved, redeemed}) == total_quota
③  同一个 (event, item, user) 至多一笔 status = 'reserved'
④  同一个 (event, code) 至多一笔
⑤  状态只能 reserved → redeemed / cancelled，不可逆
```

② 的直觉解释：**预定扣名额、取消还名额、核销不动名额**。所以「还剩的」加上「已经被占住的（含已领走的）」永远等于总数。任何一步多扣、少还、重复取消导致虚增，这个等式立刻破。

`tests/invariants.test.mjs` 用随机 400 步操作序列，**每一步之后**都断言这几条。
最近一次运行的分支覆盖：

```
预定成功 55 · 约满 58 · 重复预定 75 · 取消 34 · 核销 20 · 补货 34
账目全程平衡
```

---

## 5. 迁到云开发的对照表 ★

一年后要迁。下面这张表就是迁移清单——**只需要换 `server/repository.mjs` 一个文件，业务代码一行不动。**

| repository 方法 | 现在（SQLite） | 迁到云开发后 |
| --- | --- | --- |
| `tryReserve` | `BEGIN IMMEDIATE` + 条件 `UPDATE` + 检查 `changes === 1` | `where({_id, status:'on_sale', remainingQuota: _.gte(qty)}).update({remainingQuota: _.inc(-qty)})`，检查 `stats.updated === 1` |
| `cancelReservation` | 条件更新，只有 `reserved → cancelled` 成功才加名额 | 同上，条件更新 + `stats.updated === 1` |
| `redeem` | 条件更新 `WHERE status='reserved'` | 同上 |
| `createUser` | `INSERT`，靠唯一索引冲突 + 约束名判断原因 | `.add()`，catch 云开发的唯一索引错误码 |
| `listItems` / `getItem` / `findByCode` 等 | `SELECT` | `.where().get()` |
| `writeAudit` | `INSERT` | `.add()` |
| **鉴权** | HTTP 头带 token，服务端解出 `userId` | 云函数里 `cloud.getWXContext().OPENID` 直接拿，**这一层整层删掉** |

### 不变量怎么保证（换实现时最该盯的地方）

| 不变量 | SQLite 靠什么 | 云开发靠什么 |
| --- | --- | --- |
| ① 名额非负 | `CHECK` 约束 | 云数据库没有 CHECK，**只能靠条件更新**，所以 `_.gte(qty)` 这个条件绝对不能省 |
| ② 账目平衡 | 事务 | `runTransaction()`（云开发支持，仅云函数端） |
| ③ 一人一件 | `UNIQUE(active_key)` | 云数据库唯一索引 + `active_key` 字段，同样的写法 |
| ④ 码唯一 | `UNIQUE(event_id, code)` | 云数据库唯一索引 |
| ⑤ 单向核销 | 条件更新 | 条件更新 |

⚠️ **最需要小心的是 ①**：SQLite 有 `CHECK` 兜底，云数据库没有。迁移后如果条件更新写漏了 `remainingQuota: _.gte(qty)`，就没有第二道防线了。**迁移时务必把契约测试跑一遍。**

---

## 6. 契约测试：迁移的安全网

`tests/repository-contract.mjs` 是一份「任何实现都必须通过」的测试，不关心底层是哪种数据库，只断言业务语义（23 项）。

迁到云开发时：

```js
// tests/repository-cloud.test.mjs
import { describeRepositoryContract } from './repository-contract.mjs';
describeRepositoryContract('云开发', () => ({ repo: createCloudRepository(...) }));
```

**全绿 = 迁移没走样。** 不需要重新想一遍测试用例。

---

## 7. 还没做的（后续阶段）

- `images` 字段：现在是 `emoji` + `tint` 占位，正式版要换成图片列表
- 取货码生成策略：目前是纯随机 6 位数字 + 撞码重试；如果要求"不可枚举"，改成自增序号 + Feistel 置换 + Base32
- 分时段取货：如果要，`items` 需要加时段表
- 猫猫图鉴：数据静态打包，不进这个库；将来若要动态化，另起一组表
