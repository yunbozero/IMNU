/**
 * 单进程测试入口。
 *
 * 为什么不直接 `node --test tests/`：
 * 某些受限环境（沙箱 / 部分 CI）不允许 spawn 子进程，`node --test` 会以
 * EPERM 失败。本文件把所有测试在同一进程里 import 进来，效果等价。
 *
 * 普通终端里 `node --test tests/` 依然可用（只会匹配 *.test.mjs）。
 *
 * ⚠️ 改动本文件请用编辑器，不要用 PowerShell 的 Set-Content 重写 ——
 *    它会把中文写成非 UTF-8 字节。而 Node 读文件时会把非法字节**静默替换**
 *    成 U+FFFD 而不是报错，所以坏掉的注释能一路蒙混过关，直到有人用严格
 *    解码的工具打开它。tests/encoding.test.mjs 就是为此加的守卫。
 */
import './api.test.mjs';
import './api-admin.test.mjs';
import './auth.test.mjs';
import './backup.test.mjs';
import './deploy.test.mjs';
import './encoding.test.mjs';
import './invariants.test.mjs';
import './lan.test.mjs';
import './longimage.test.mjs';
import './miniprogram-lint.test.mjs';
import './miniprogram.test.mjs';
import './proposal.test.mjs';
import './prototype.test.mjs';
import './quota-concurrency.test.mjs';
import './repository.test.mjs';
import './roles.test.mjs';
import './secrets.test.mjs';
import './shell.test.mjs';
