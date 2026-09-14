/**
 * 设立第一个超管。
 *
 *   node scripts/set-owner.mjs <openid>
 *   # 或者
 *   OWNER_OPENID=xxx node scripts/set-owner.mjs
 *
 * 为什么必须单独有这么一个脚本：
 *   转交超管要求「已经有一个超管」，而 setUserRole 又拒绝直接设成 owner ——
 *   所以第一个超管没法通过任何界面产生，只能由服务端在初始化时设立。
 *
 * 安全性：repository.bootstrapOwner 只在**当前一个超管都没有**时才生效。
 * 有了超管之后它永远拒绝，所以这个脚本不是后门。
 *
 * 怎么拿到自己的 openid：
 *   先在小程序里登记一次，然后：
 *     DB_PATH=... node scripts/set-owner.mjs --list
 *   会列出所有已登记的人。
 */
import { openMigrated } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';

const dbPath = process.env.DB_PATH || './tmp/bazaar.db';
const openid = process.argv[2] || process.env.OWNER_OPENID || '';

const db = openMigrated(dbPath);
const repo = createSqliteRepository(db);

try {
  if (process.argv.includes('--list') || !openid) {
    const rows = db.prepare('SELECT id, openid, sid, name, role FROM users ORDER BY created_at').all();
    if (!rows.length) {
      console.log('还没有任何已登记的用户。先在小程序里登记一次，再回来跑这个脚本。');
    } else {
      console.log(`数据库：${dbPath}\n`);
      console.log('已登记的用户：');
      for (const r of rows) {
        console.log(`  ${r.role.padEnd(10)} ${r.name}（学号 ${r.sid || '—'}）`);
        console.log(`             openid: ${r.openid}`);
      }
    }
    if (!openid) {
      console.log('\n用法：node scripts/set-owner.mjs <openid>');
      process.exit(0);
    }
  }

  const owners = repo.countOwners();
  if (owners > 0) {
    console.error(`[x] 当前已经有 ${owners} 个超管了，不能再用这个脚本设立。`);
    console.error('    换届请让现任超管在小程序里走「转交超管」。');
    process.exit(1);
  }

  const user = repo.findUserByOpenid(openid);
  if (!user) {
    console.error(`[x] 找不到 openid 为 ${openid} 的用户。`);
    console.error('    先让他在小程序里完成登记，再跑 node scripts/set-owner.mjs --list 看看。');
    process.exit(1);
  }

  const r = repo.bootstrapOwner(user.id);
  if (!r.ok) {
    console.error(`[x] 设立失败：${r.reason}`);
    process.exit(1);
  }

  repo.writeAudit({
    actorId: null, action: 'owner.bootstrap',
    targetType: 'user', targetId: user.id,
    detail: { openid, via: 'scripts/set-owner.mjs' },
  });

  console.log(`✅ ${user.name} 已设为超级管理员`);
  console.log('   之后请在小程序里用「转交超管」把身份交给学弟学妹，而不是再跑这个脚本。');
} finally {
  db.close();
}
