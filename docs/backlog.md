# 待办清单（Backlog）

> 这份清单是 2026-10-22 对全仓库做了一次分区块通读之后记下来的，
> 每条都回到代码核实过（给了 `文件:行`）。做完一条就划掉一条，
> 不要让它变成「看过但没人做」的清单。
>
> 状态约定：**未做** / **进行中** / **已做（日期）**

---

## 一、发布前必修（用户能看到的错）

> 2026-10-22 四项已全部完成，见文末「已做」。这张表留着是为了记住它们当初是怎么被发现的。

| # | 位置 | 问题 | 工作量 | 状态 |
| --- | --- | --- | --- | --- |
| A2 | `packageBazaar/pages/pickup-code/index.wxml:14` | 已取货状态条直接渲染 `{{reservation.redeemedAt}}`，那是毫秒时间戳 → 显示「· 1712345678901」。同字段在 scan / my-reservations 都过了 `timeText()` | S | 未做 |
| A3 | `pickup-code:130`、`item-new:139`、`cat-edit:170`、`cancel:118`、`scan:103` | 裸 `setTimeout` 不落变量、`onUnload` 不清 → 用户手动返回后会**多退一层**；`scan` 输满 6 位后再按数字键会重复 arm，连点会发两次 `/api/redeem`，第二次红字「已核销」误导志愿者 | S | 未做 |
| A4 | 6 处空态 + 4 处错误条 | 空态条件只判 `!loading && list.length === 0`，没排除 `error` → 接口一挂就是「加载失败 + 这里还没有记录」同时出现（`bazaar/items:32`、`my-reservations:17`、`admin/reservations:52`、`admin/items:11`、`admin/cats:9`、`admin/roles:7`）；`detail:3`、`pickup-code:3`、`scan:3`、`admin/cancel:3` 的错误条没有重试入口 | S | 未做 |

## 二、文档漂移

| # | 位置 | 文档说 | 代码实际 | 状态 |
| --- | --- | --- | --- | --- |
| B1 | `docs/api.md` | 24 个小节 | `server/http.mjs` 有 29 条路由：缺 `GET /api/cats`、`/api/admin/cat/create`、`/api/admin/cat`、`/api/admin/cat/delete`、`GET /api/admin/users` | 未做 |
| B2 | `docs/api.md:27-30` | error 取值 16 个 | 实际还返回 `event_conflict`、`item_has_pending`、`stall_exists`、`too_many`、`too_large`、`not_image`、`wx_not_configured`、`owner_immutable`、`use_transfer`、`self_change` | 未做 |
| B3 | `docs/api.md`「还没做的」 | 「删不了物品」「任命角色没有界面」 | 删除物品已上界面（`admin/items:130-155`）；角色页已存在（`packageAdmin/pages/roles`） | 未做 |
| B4 | `docs/admin-plan.md:64/164/166` | 「活动和摊位没有任何界面入口」「删除物品只能下架」「任命角色界面没做」 | 三处都已过时（同文件 `:168` 反而写对了） | 未做 |
| B5 | `docs/admin-plan.md:155`、`scripts/set-role.mjs:16` | 「设角色本次未选」「没有界面」 | `1859b0b` 已加角色管理页，`profile/index.wxml:73-79` 有入口 | 未做 |
| B6 | `docs/data-model.md:80/152/248` | `items.status` 两态、四个唯一索引、图片是 emoji 占位 | 实际三态（含 `deleted`）、五个唯一索引、`image` 列已实现 | 未做 |
| B7 | `docs/ui-prototype-plan.md:44/53/195`、`docs/local-dev.md:29` | Tab 三项与实际不符、S1 收学号、要求出现「不出售商品」否定句、管理端「界面还没做」 | tabBar 是 首页/猫猫图鉴/我的；只收昵称；`admin-plan.md:227-230` 判定否定句不能出现；管理端 8 页 | 未做 |
| B8 | `prototype/index.html:69`、`assets/data.js:7/10/64` | 原型仍叫「IMNU 校园义卖」，带学校/社团主办方，S1 收学号 | 小程序侧是「盛师猫猫」；这正是备案会踩线的措辞 | 未做 |
| B9 | 新增守卫测试 | 从「代码加了接口、文档没加」这个方向加一条测试，让 §B1 不再复发 | 建议断言 `ROUTES` 每一条在 `api.md` 有对应小节 | 未做 |

## 三、死代码

| # | 位置 | 内容 | 状态 |
| --- | --- | --- | --- |
| C1 | `server/http.mjs:215/344/222` | `maskCode()` 零调用；`maskBody()` 不接参数、恒返回 undefined，却被写成 `body: maskBody(req, e)`（看着像脱敏其实没有）；`version` 参数未使用 | 未做 |
| C2 | `server/http.mjs:285` → `server/api.mjs:448` | `rateLimited` 从不置 true（限流在 http 层直接 429），api 里那条分支是死的，全仓测试零引用 | 未做 |
| C3 | `server/repository.mjs:141`、`server/http.mjs:206`、`server/api.mjs:513` | `inTransaction` 零调用；`if (!payload.uid)` 恒假；`MESSAGES.cancelled_reservation \|\| …` 恒真 | 未做 |
| C4 | `miniprogram/config.js:63/70-76/84`、`app.js:27-35`、`utils/format.js:93`、`packageAdmin/utils/cat-form.js:36`、`services/platform.js:57` | `IS_DEVTOOLS`/`IS_DEV`/`FALLBACK_EVENT_TEXT`/`loadEvent()`/`pickerLabel`/`statusLabel`/`getScreenBrightness` 全仓无引用 | 未做 |
| C5 | `miniprogram/pages/cats/index.wxss:60-73` | 整个 `.entry` 块，wxml 里没有任何 `entry` 类 | 未做 |
| C6 | `admin/reservations:67`、`admin/cancel:63` | 两处 `x.userSid ? '学号' …` 分支：学生端已不收 sid，永远不成立 | 未做 |

## 四、重复（改一次要动 2–18 处）

| # | 内容 | 重复量 | 状态 |
| --- | --- | --- | --- |
| D1 | `cat-edit/index.wxss` 与 `item-new/index.wxss` | 82 行整份相同，只差第 1 行注释 | 未做 |
| D2 | `.segmented` 控件（cats 版 27rpx、其余 26rpx，**已经漂移**） | 4 份 | 未做 |
| D3 | `.op` 小按钮 / `.entry` 入口卡 / `.mask+.sheet` | 6 / 3 / 2 份 | 未做 |
| D4 | `new Promise(resolve => wx.showModal(...))` | 13 处（7 个页面） | 未做 |
| D5 | `box-shadow: 0 4rpx 20rpx rgba(150,90,60,0.06)` 硬编码 | 18 处 | 未做 |
| D6 | `server/api.mjs` 鉴权骨架：`!user` 23 次、`!isManager` 7 次、`!isStaff` 4 次 | 34 处 | 未做 |
| D7 | 测试里的 `call()` HTTP 助手（api / api-admin / cats / images） | 4 套，已开始漂移 | 未做 |
| D8 | 脚本里的 `DB_PATH` + `openMigrated` + 主模块检测 | 4 套（init-event / seed-dev / set-owner / set-role） | 未做 |

## 五、server 侧的其他发现

| # | 位置 | 问题 | 工作量 | 状态 |
| --- | --- | --- | --- | --- |
| S1 | `server/api.mjs:1314` | `fmtTime()` 用 `getHours()` 按**服务器本地时区**，是全库唯一不按北京时间的地方；部署机 UTC 时导出名单里时间差 8 小时，且没测试断言 CSV 时间 | S | 未做 |
| S2 | `server/backup.mjs:28` | `REQUIRED_TABLES` 漏 `cats`、`settings`，缺这两张表的备份仍判 ok，恢复后图鉴被重建成空表 | S | 未做 |
| S3 | `server/api.mjs:1282`、`:790` | 裸 `Number(raw)`：`{"maxItemsPerUser": []}` 静默变 0＝全账号不限量；`{"quotaDelta": true}` 悄悄 +1 名额 | S | 未做 |
| S4 | `server/api.mjs:851`、`:918` | 注释说传图/建猫「副主任及以上」，代码是 `isStaff`（志愿者），测试钉的也是志愿者 → 有人「按注释改代码」就会把门槛抬错 | S | 未做 |
| S5 | `server/api.mjs:812` | 删物品前为了数 pending 调 `listEventReservations`，它会额外查全场物品 + 全部用户，随后在 JS 里 filter 一件 | S | 未做 |
| S6 | `server/api.mjs:1243`、`:554` | 读接口 403 文案写成「改设置需要一级管理员」；`adminCancel` 兜底分支丢掉 `r.reason` 只说「取消失败，请重试」 | S | 未做 |
| S7 | `server/http.mjs:269` | `auth:'none'` 的公开路由（首页/图鉴最热）也验 token 并查一次库 | S | 未做 |
| S8 | `server/repository.mjs:344` | 幂等预检在 `BEGIN IMMEDIATE` 之前，事务里没有 `request_id` 冲突分支 → 真并发时返回 `dup` 而非幂等成功。**只对多进程/worker 架构可触发**，当前单进程撞不到 | S | 未做（待定是否值得） |
| S9 | `server/backup.mjs:297`、`:289` | 备份用裸 `new DatabaseSync` 绕过 `openDatabase`（缺 `busy_timeout`）；DB 路径硬编码，与 `db.mjs:15-21`「路径唯一来源」相悖 | S | 未做 |

## 六、测试侧

| # | 内容 | 状态 |
| --- | --- | --- |
| T1 | `tests/all.mjs` 缺守卫：新加 `*.test.mjs` 忘了登记就永远不跑，而发布闸门正是它 | 未做 |
| T2 | `tests/deploy.test.mjs:55-88` 死代码 + bash 路径写死作者机器（`C:\z_Downloads\Git\bin\bash.exe`），别的机器上 `bash -n` 语法检查静默 skip | 未做 |
| T3 | `miniprogram/services/api.js` 零覆盖：`statusToCode`、FALLBACK 文案、429 Retry-After、非 JSON 兜底、timeout vs network | 未做 |
| T4 | `tests/prototype.test.mjs:218` 恒真断言 `assert.equal(f(x), f(x))` | 未做 |
| T5 | `tests/encoding.test.mjs:16` 从别的测试文件借 helper（单跑会连带跑 secrets 的 8 条） | 未做 |
| T6 | 每个 HTTP 用例都重建库 + 起服务（约 115 次），是总耗时的主要开销 | 未做 |
| T7 | `tests/quota-concurrency.test.mjs:77` 最慢单项：120 次事务 + 8 线程；2/3 条只抢 3 次却仍起 8 个 worker | 未做 |
| T8 | 源码文本断言偏脆：`miniprogram.test.mjs:1139/1222/1313`、`cats.test.mjs:623` 绑缩进与引号风格 | 未做 |
| T9 | `tests/api-admin.test.mjs:506-509` CSV 只做 `match`，列错位也全绿 | 未做 |

## 七、脚本与部署

| # | 内容 | 状态 |
| --- | --- | --- |
| X1 | `scripts/set-role.mjs:150` 默认库是 PROD，而 set-owner/seed-dev 默认 DEV → 本地跑 `set-role --list` 会真的建 `C:\srv\bazaar\data\` 空库 | 未做 |
| X2 | `deploy/push-from-local.sh:74/79/80` scp/ssh 没有 `ConnectTimeout`/`BatchMode`，远端 `cd $APP_DIR` 未引号 | 未做 |
| X3 | `package.json` 无 `engines`，而 `node:sqlite` 要求 ≥22.5；`server/db.mjs:4` 注释写 24，三处口径不一 | 未做 |
| X4 | `deploy-alicloud.md:4` 状态行过期、`:823-831` 文件分工表缺 `push-from-local.sh` 与 `www/index.html` | 未做 |

## 八、需要拍板的（不是 bug）

| # | 争议点 | 状态 |
| --- | --- | --- |
| F1 | 「一人一份」与功能矛盾 | ✅ 已定：改文案为「一人一次：同一件物品每人只约一次；需要多份的，在预定页选数量」 |
| F2 | 两种叫法：「只登记名额」vs「只锁定名额」 | ✅ 已统一成「只登记名额」 |
| F3 | 名额单位四种：个 / 件 / 份 / 无单位（`quotaText`） | 未定（判断：物品论「件」、数量论「份」，可能本来就不是矛盾） |
| F4 | 时间按手机时区算 | ✅ 已改：`timeText/clockText` 固定 +08:00，并有「禁止本地 getter」守卫 |
| F5 | 合规措辞「在售 / 上架 / 下架」 | ✅ 已改：全部换成「开放预定 / 关闭预定」，含服务端提示与守卫测试 |
| F6 | **副主任没有「任命志愿者」的界面入口** | 未定（2026-10-23 决定先保持现状）。服务端允许副主任调 `adminSetRole`，但他只能任命志愿者；界面门槛在一级管理员，所以现场只能找一级管理员，或跑 `scripts/set-role.mjs`。**如果要做**：不要放开整页（会让副主任看到全员名单与详情），另开一个「志愿者管理」入口，只列志愿者+学生、只能设为志愿者，约 60 行。 |

---

## 已做

| 日期 | 内容 |
| --- | --- |
| 2026-10-22 | **A1**：`handleError` 用 `navigateTo` 跳 tabBar 页（「我的」）静默失败 → 改 `switchTab` + 一句 toast；删 `profile` 里读 `query.register` 的死代码；**给 lint 补上 `services/utils/data` 的扫描范围**（这条 bug 之前一路是绿的）。测试 542 项 0 失败 |
| 2026-10-22 | **A2–A4**：取货码页不再显示裸时间戳；5 处 `setTimeout` 落账 + `onUnload` 清理 + 核销台防连点；6 处空态补 `!error`、3 处错误条可点重试。新增 `tests/miniprogram-states.test.mjs` 四条静态守卫 |
| 2026-10-22 | **B（时间）**：`timeText/clockText` 固定北京时间 + 守卫 |
| 2026-10-22 | **A（措辞）**：统一「只登记名额」、`在售/上架/下架` → `开放预定/关闭预定`、`一人一份` → `一人一次`，含服务端 3 处提示与守卫 |
| 2026-10-22 | **活动口令（V1）**：`events.pass_code` + `/api/admin/event/pass` + 预定弹层里的一栏；服务端强制、按活动缓存、错 5 次锁 1 小时；学生端接口只返回 `passRequired` 不返回口令 |
| 2026-10-22 | **未取货降权**：上一场 `reserved` 未核销 → 本场上限压到 1 件（`maxPerUserCap`，在事务里收紧，并发也不超）；取消/核销过的不算 |
| 2026-10-22 | **决定不做账号密码体系**：openid 一人一号已由唯一索引保证；忘密码没有自救通道（个人主体无短信/邮件），真要电脑端管理台应走「小程序扫码登录」 |
| 2026-10-22 | **延后**：设备弱指纹（机型/系统组合）只作以后优化项，且只能用于「预警给管理员」，不能作拒绝依据 |
