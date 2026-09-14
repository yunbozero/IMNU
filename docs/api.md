# 义卖后端接口

> 状态：已实现并通过端到端测试（`server/http.mjs` · `server/api.mjs`）
> 本地起服务：`SESSION_SECRET=$(openssl rand -hex 32) npm start`

---

## 响应约定

**刻意区分「传输出错」和「业务失败」**——这一点对小程序端很重要：

| 状态码 | 含义 | 小程序该怎么处理 |
| --- | --- | --- |
| `200 {ok:true, ...}` | 成功 | 正常走 |
| `200 {ok:false, error, message}` | **业务失败**：约满、重复预定、已核销…… | **弹 `message` 给用户**，不要当成网络异常去重试 |
| `400` | 参数不对 | 这是前端 bug，弹通用提示 |
| `401` | 没登录 / token 失效 | 重新走登录 |
| `403` | 登录了但没权限 | 弹「你没有权限」 |
| `404` | 路由或资源不存在 | 弹通用提示 |
| `405` | 请求方法不对 | 前端 bug |
| `413` | 请求体过大 | 前端 bug |
| `429` | 请求太频繁 | 稍后重试，响应头带 `Retry-After` |
| `500` | 服务端 bug | 弹「服务出错了」，日志里有堆栈 |

`error` 是稳定的机器可读字符串，`message` 才是给人看的中文。**前端只该对 `error` 做分支，不要匹配 `message`。**

现有 `error` 取值：
`soldout` `dup` `off_shelf` `not_found` `code_taken` `invalid_code` `already_redeemed`
`cancelled` `sid_taken` `openid_taken` `rate_limited` `unauthorized` `forbidden`
`bad_request` `no_active_event` `login_failed`

---

## 认证

除了 `/api/health`、`/api/event`、`/api/items`、`/api/login`，其余接口都要带：

```
Authorization: Bearer <token>
```

有两种 token：

| 作用域 | 什么时候拿到 | 能干什么 |
| --- | --- | --- |
| `register` | 登录成功但还没登记 | **只能**调 `/api/register` |
| `user` | 登记成功、或已登记用户登录 | 其余所有需要身份的接口 |

这样设计是为了让前端不用自己保存 openid，也不用在「登录了但还没登记」这个中间态上纠结。

---

## 接口一览

### `GET /api/health`

不需要登录。

```json
{"ok":true,"service":"bazaar-api","version":"1.0.0","uptimeMs":1824,"serverTime":1789388719038}
```

`serverTime` 是服务端毫秒时间戳。**倒计时之类的一定要用它，不要信客户端时间。**

### `GET /api/event`

活动信息 + 摊位列表。不需要登录。

```json
{
  "ok": true,
  "event": {"id":"ev_...","name":"IMNU 校园义卖","startsAt":null,"endsAt":null,"status":"on_sale"},
  "stalls": [{"id":"st_...","eventId":"ev_...","name":"一号摊位","loc":"图书馆前广场东侧"}],
  "serverTime": 1789388719038
}
```

活动没开始时 `event` 是 `null`（不是报错），前端显示「活动还没开始」。

### `GET /api/items`

物品列表。不需要登录。

```json
{
  "ok": true,
  "event": {...},
  "items": [{
    "id":"it_...","name":"手作黄油曲奇（6枚装）","description":"...",
    "emoji":"🍪","tint":"t-yellow",
    "totalQuota":40,"remainingQuota":12,"status":"on_sale",
    "stallId":"st_...","stallName":"二号摊位","stallLoc":"学生活动中心门口"
  }]
}
```

**注意：响应里没有任何金额字段，这是硬约束，有测试守着。**

`remainingQuota` 是展示用的。**真正算数的是 `/api/reserve` 的返回结果**——前端显示「还剩 1 件」不代表你一定抢得到。

### `POST /api/login`

不需要登录。

```json
// 请求
{"code": "wx.login() 拿到的 code"}

// 已经登记过的人
{"ok":true,"token":"<user token>","registered":true,"user":{...}}

// 还没登记
{"ok":true,"token":"<register token>","registered":false,"user":null}
```

微信登录失败时返回 `401 {error:"login_failed"}`，**不会把微信的原始错误泄露给客户端**。

### `POST /api/register`

需要 `register` 作用域的 token。

```json
// 请求
{"sid": "2021123456", "name": "王雨桐"}

// 成功 —— 同时返回一个 user token，可以直接用
{"ok":true,"user":{...},"token":"<user token>"}
```

学号必须 6–16 位数字，姓名 2–12 个字符。学号已被占用返回 `{ok:false,error:"sid_taken"}`。

### `GET /api/me`

需要 `user` token。

```json
{"ok":true,"user":{...},"isStaff":false}
```

`isStaff` 为 `true` 时前端才显示「志愿者核销台」入口。**但这只是界面控制，真正的权限判断在服务端。**

### `GET /api/reservations`

需要 `user` token。返回我的全部预定（含已取货、已取消）。

```json
{"ok":true,"event":{...},"reservations":[{
  "id":"r_...","itemId":"it_...","qty":1,"code":"482913",
  "status":"reserved","createdAt":1789388719038,"redeemedAt":null,
  "itemName":"手作黄油曲奇（6枚装）","emoji":"🍪","tint":"t-yellow",
  "stallName":"二号摊位","stallLoc":"学生活动中心门口"
}]}
```

`status` 只有三个值：`reserved`（待取货）/ `redeemed`（已取货）/ `cancelled`（已取消）。

**不要把内部状态机暴露给用户**，前端只按这三个值展示就行。

### `POST /api/reserve` ⭐ 核心

需要 `user` token。**有限流**（默认每人 10 秒 10 次）。

```json
// 请求
{
  "itemId": "it_...",
  "qty": 1,
  "requestId": "客户端生成的唯一字符串"
}
```

`requestId` 是**防重复提交的幂等键**，必填。用 `crypto.randomUUID()` 生成，同一笔预定重试时要**复用同一个值**——这样网络超时重发不会产生两单。

```json
// 成功
{"ok":true,"reservation":{...},"remaining":11}

// 约满
{"ok":false,"error":"soldout","message":"手慢了，名额刚刚被约满"}

// 同一人重复预定同一件
{"ok":false,"error":"dup","message":"你已经预定过这件物品了"}
```

**这个接口是整套系统里唯一会扣减名额的地方。** 服务端用一条带条件的原子 UPDATE 保证不超卖，数据库层还有 `CHECK (remaining_quota >= 0)` 兜底。

已经实测过：8 个线程并发抢 20 个名额，恰好卖出 20 份。

### `POST /api/cancel`

需要 `user` token。

```json
// 请求
{"reservationId": "r_..."}

// 成功
{"ok":true,"released":2,"reservation":{...}}
```

**只能取消自己的预定**——服务端会查归属，不依赖前端不显示按钮。重复取消第二次会失败，名额不会虚增。

### `POST /api/redeem`

需要 `user` token，且角色必须是 `volunteer` / `admin` / `owner`。

```json
// 请求
{"code": "482913"}

// 成功
{"ok":true,"reservation":{...}}

// 已经核销过（带首次核销的信息，方便志愿者判断）
{"ok":false,"error":"already_redeemed","message":"这个码已经核销过了"}
```

失败原因分四种，**不要合并成一句「核销失败」**，志愿者在人群里没时间猜：

| `error` | 含义 |
| --- | --- |
| `invalid_code` | 取货码不存在 |
| `already_redeemed` | 已经核销过 |
| `cancelled` | 学生自己取消了 |
| `forbidden` | 你不是志愿者 |

---

## 还没做的

- **管理后台接口**：物品上下架、取消他人预定、导出名单、角色任命与转交
- **分时段取货**：现在取货时间只有活动级别的，没有分时段
- **摊位分权**：现在志愿者可以核销任意摊位的码

这三个都要等方案确认后再定（见 `docs/ui-prototype-plan.md` 第 9 节的待确认项）。
