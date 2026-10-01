# packageBazaar/lib —— 引入的第三方代码

这个目录里是**第三方代码**。本仓库其他地方一律零第三方依赖，这里是唯一的例外，
所以把来历、改动和原因都写清楚。

## qrcode.js

- **上游**：`qrcode-generator` v1.4.4 —— https://www.npmjs.com/package/qrcode-generator
- **文件**：https://unpkg.com/qrcode-generator@1.4.4/qrcode.js
- **上游 sha256**：`18AE399F81182BC9DE916E9C77B195DF20CC58D6F2D55A62B085A299F1BF1780`
- **许可证**：MIT，Copyright (c) 2009 Kazuhiko Arase（版权声明**原样保留在文件头部**）
- **作者**：Kazuhiko Arase，http://www.d-project.com/

### 做了什么改动

**只改了一处**：把文件末尾的 UMD 包装

```js
(function (factory) { ... if (typeof exports === 'object') { module.exports = factory(); } ... }));
```

换成一行 ESM 导出：

```js
export default qrcode;
```

原因：小程序端统一用 ESM，而本仓库有一条测试禁止混用 `require` 和 `import`，
所以不能留着 CommonJS 分支。**编码逻辑本身一行未动。**

### 为什么不直接用 jsDelivr 的 `+esm` 构建

试过了：jsDelivr 的 `+esm` 产物是 21702 字节的压缩包，但它**把 MIT 版权头整个剥掉了**。
MIT 要求分发时保留版权声明，所以那个版本不能用。

### 为什么不自己写一个

二维码编码不算"难"，但要实现 RS 纠错和掩码选择，而且**它的故障形态特别难查**：
不会报错，只是"大部分时候能扫、偶尔扫不出"。义卖现场没人能当场调这个。
用成熟实现 + 一个测试验证它真的产出合法矩阵，比手写更划算。

### 引入前的审查结论

- 无 `eval` / `new Function`
- 无网络调用（`fetch` / `XMLHttpRequest`）
- 无 `require`
- 是合法 UTF-8

这几条已经固化成 `tests/qrcode.test.mjs` 里的断言，以后升级时会被自动检查。

### 升级方式

1. 下载新的 `qrcode.js`，核对 sha256
2. 同样只替换末尾的 UMD 包装为 `export default qrcode;`
3. 更新本文件的版本号与哈希
4. 跑 `node tests/all.mjs`
