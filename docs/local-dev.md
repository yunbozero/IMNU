# 本机联调清单

目标：**在不用域名、不用证书、不用备案的前提下，把小程序主流程完整跑一遍。**

这条路和线上完全隔离 —— 后端跑在 `127.0.0.1:3000`，小程序在开发者工具里连本机。
备案和 HTTPS 都不参与，所以等待期里就能做。

---

## 0. 前置条件

```bash
node -v        # 需要 ≥ 22.5，因为用了内置的 node:sqlite
```

版本不够就先升 Node，别往下走 —— 低版本的报错信息完全指不到原因。

---

## 1. 造演示数据

```bash
npm run seed
```

会建一个「演示义卖（本地）」活动、2 个摊位、6 个物品（其中一个只留 3 个名额，
用来验证「快约满」的状态），以及一个演示志愿者。

> 为什么需要它：**管理端界面还没做**，而新建的库是空的。
> 没有数据的话，首页/列表/详情/预定全都只能看到空状态，联调等于没测。
> 已经有在售活动时它会跳过，重复跑不会造重复数据。

## 2. 起后端（打开假登录）

```bash
# Git Bash / macOS / Linux
DEV_FAKE_LOGIN=1 npm start

# Windows PowerShell
$env:DEV_FAKE_LOGIN='1'; npm start
```

看到这两行就对了：

```
[!] 已启用本地假登录（DEV_FAKE_LOGIN=1）：任何 code 都能登录。线上绝不可用。
✅ bazaar-api 已启动 http://127.0.0.1:3000
```

另开一个终端验证：

```bash
curl -s http://127.0.0.1:3000/api/health
# {"ok":true,"service":"bazaar-api",...}
```

> 假登录只是为了本地能绕开微信登录（那需要 AppID/AppSecret）。
> 它有两道锁：`NODE_ENV=production` 和 `/srv/bazaar` 数据目录，**任一命中就拒绝启动**，
> 所以本地的环境变量整份抄到服务器上也开不起来。见 `tests/dev-runtime.test.mjs`。

## 3. 导入微信开发者工具

1. **导入项目时选 `miniprogram` 这一层目录**（不是仓库根目录）——
   `project.config.json` 在那里。选错会得到一个空项目。
2. AppID 填**你自己的**。默认的 `touristappid` 只能看，不能预览和上传。
3. 「详情 → 本地设置」勾上
   **「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」**。
   这是个本地设置，会写进 `project.private.config.json`，不需要提交。
4. 不用改 `config.js` —— 它按 `platform === 'devtools'` 判断，
   在模拟器里自动用 `http://127.0.0.1:3000`。**别改回按 `envVersion` 判断**，
   那样真机会拿到 `127.0.0.1`（手机自己），所有请求静默失败。

## 4. 假登录怎么用：code 就是身份

登录接口把 `code` 直接映射成 `openid:<code>`，所以**换一个 code 就是换一个人**。
这正是本地测多角色的方式。

| 输入 code | 你会变成 |
| --- | --- |
| `dev-volunteer` | 演示志愿者，**能进核销台** |
| `alice`、`bob`……任意别的 | 一个新用户，走学号 + 姓名登记 |

## 5. 完整验收路径

**学生端**

1. 用 code `alice` 登录 → 登记（学号 `2023001`、姓名随便）
2. 首页 → 进义卖列表，点任意物品看详情
3. 预定一个名额 → 记下取货码
4. 「我的预定」里能看到它；再预定同一个物品应当被挡住（一人一件）
5. 猫猫图鉴能正常浏览

**志愿者端**

6. 换 code `dev-volunteer` 重新登录 → 进核销台
7. 输入刚才的取货码 → 核销成功；再输一次应当提示已核销

**管理员**

8. 用某个 code 登录并登记，然后：

   ```bash
   node scripts/set-owner.mjs --list          # 找到你的 openid
   node scripts/set-owner.mjs <你的openid>     # 提成超管
   ```

9. 回小程序重新进入，确认身份变了

> 本地服务连的库和 `set-owner` 用的是**同一个路径**（都在 `server/db.mjs` 里定义）。
> 以前这两处各写一份默认值，结果一个连 `tmp/bazaar-dev.db`、一个连 `tmp/bazaar.db`，
> 现象是「明明登记过了却说没有用户」。

## 6. 卡住了先看这几条

| 现象 | 原因 |
| --- | --- |
| 所有请求都失败 | 后端没起，或忘了勾「不校验合法域名」 |
| 「还没有任何已登记的用户」 | `DB_PATH` 和后端用的不是同一个库 |
| 启动报 `node:sqlite` 相关错误 | Node 版本低于 22.5 |
| 登录返回失败 | 没设 `DEV_FAKE_LOGIN=1`，且没配 `WX_APPID`/`WX_SECRET` |
| 物品卡片没有背景色 | `tint` 和 `app.wxss` 里的色底类对不上（有测试挡这个） |

## 7. 这套东西绝不能上线的部分

- `DEV_FAKE_LOGIN=1` —— 任何 code 都能登录。生产有两道锁 + 测试挡着。
- `npm run seed` —— 往库里塞演示数据。同样拒绝在 `NODE_ENV=production`
  或 `/srv/bazaar` 路径上运行。
