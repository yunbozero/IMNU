# 猫猫图鉴的照片

把猫的照片放在这个目录里，文件名写进 `miniprogram/data/cats.js` 的 `image` 字段
（写 `cats/文件名`），发布时 `deploy/deploy.sh` 会把它们同步到服务器的图片目录，
由 nginx 直接发。

```js
// miniprogram/data/cats.js
{
  id: 'c1',
  name: '大橘',
  image: 'cats/daju.jpg',   // ← 就是这里
  ...
}
```

## 文件名必须是纯 ASCII

**只能用小写字母、数字、下划线、短横线**，扩展名 `.jpg` / `.png` / `.webp` / `.gif`。
例如 `daju.jpg`、`cat_01.jpg`、`xiao-hei.jpg`。

### 为什么（这个坑很隐蔽）

小程序的 `<image>` 会把中文文件名做**百分号编码**，而服务端的静态图片服务
**故意不做 URL 解码** —— 那是为了从一开始就不存在路径穿越问题
（见 `server/images.mjs` 和 `server/http.mjs` 的 `sendImage`）。

两边一撞的结果：`cats/大橘.jpg` 会请求成 `/images/cats/%E5%A4%A7%E6%A9%98.jpg`，
直接 **404**，而界面因为「加载失败回落 emoji」**不会报任何错** ——
你只会看到那只猫一直没有照片，完全想不到是文件名的问题。

`tests/miniprogram.test.mjs` 有一条守卫盯着这个规则。

## 大小建议

**压到 300KB 以内，宽边 600–800px 就够。** 图鉴列表一屏好几张，
原图（三五 MB）在校园网上会明显卡顿。`deploy.sh` 遇到超过 300KB 的会提醒，
但不拦。

手机上压缩最省事的办法：微信发给自己一遍（会压），再存回相册。

## 目录里没有照片时

`image: null` 就回落成 `emoji` + 底色那个色块 —— 断网、加载失败也一样回落，
所以**图鉴永远能看**，不会出现一片空白。
