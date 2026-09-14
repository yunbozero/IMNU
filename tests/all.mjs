/**
 * 单进程测试入口。
 *
 * 为什么不直接 `node --test tests/`：
 * 某些受限环境（沙箱 / 部分 CI）不允许 spawn 子进程，`node --test` 会以
 * EPERM 失败。本文件把所有测试在同一进程里 import 进来，效果等价。
 *
 * 普通终端里 `node --test tests/` 依然可用（只会匹配 *.test.mjs）。
 */
import './prototype.test.mjs';
import './proposal.test.mjs';
import './longimage.test.mjs';
import './repository.test.mjs';
import './quota-concurrency.test.mjs';
import './invariants.test.mjs';
import './backup.test.mjs';
import './deploy.test.mjs';
import './lan.test.mjs';
