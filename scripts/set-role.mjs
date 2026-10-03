/**
 * 改某个已登记账号的角色。
 *
 *   node scripts/set-role.mjs --list
 *   node scripts/set-role.mjs <openid> volunteer
 *   node scripts/set-role.mjs <openid> deputy
 *
 * 线上要在服务器上跑，并且**必须用 bazaar 账号**：
 *
 *   sudo -u bazaar DB_PATH=/srv/bazaar/data/bazaar.db \
 *     node /srv/bazaar/app/scripts/set-role.mjs --list
 *
 * ------------------------------------------------------------------
 * 为什么需要这个脚本
 * ------------------------------------------------------------------
 * 小程序里**没有任命角色的界面**（接口 `POST /api/admin/role` 早就有了，界面一直没做），
 * 而 set-owner.mjs 只在「一个超管都没有」时生效一次。
 * 于是义卖当天最要紧的那件事 —— 给几个志愿者开核销权限 ——
 * 在线上**没有任何入口**。这个脚本补的就是这个口子。
 *
 * ------------------------------------------------------------------
 * ★ 手机上的账号和开发者工具里的**不是同一个**
 * ------------------------------------------------------------------
 * 开发者工具里 `wx.login` 给的是随机 code，每次清缓存都换一个假身份；
 * 而真人从「预览 / 体验版 / 正式版」进小程序时拿的是**真实 openid**，
 * 落在**线上库**里。所以给手机那个账号提权，必须对着线上库跑，
 * 而且要认出是**哪一行** —— 用 --list 按昵称找。
 */
import { openMigrated, PROD_DB_PATH } from '../server/db.mjs';
import { createSqliteRepository } from '../server/repository.mjs';
import { ROLES, ROLE_LABEL } from '../server/roles.mjs';

/** 这个脚本能设的角色。★ 没有 owner —— 超管只能由 set-owner / 转交超管产生。 */
export const ASSIGNABLE = ROLES.filter((r) => r !== 'owner');

export const USAGE = `
用法：
  node scripts/set-role.mjs --list                  看看都有谁、现在是什么角色
  node scripts/set-role.mjs <openid> <角色>         改角色

角色（角色名照抄，别写中文）：
${ASSIGNABLE.map((r) => `  ${r.padEnd(10)} ${ROLE_LABEL[r]}`).join('\n')}

  超管（owner）**不能**在这里设：它只能由 scripts/set-owner.mjs 设立一次，
  之后换届走小程序里的「转交超管」。

线上：
  sudo -u bazaar DB_PATH=/srv/bazaar/data/bazaar.db \\
    node /srv/bazaar/app/scripts/set-role.mjs --list
`.trim();

/* ============================================================
   参数
   ============================================================ */

export function parseArgs(argv) {
  const args = { list: false, openid: '', role: '', help: false };

  for (const a of argv) {
    if (a === '--list' || a === '-l') args.list = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('-')) throw new Error(`不认识的参数：${a}`);
    else if (!args.openid) args.openid = a;
    else if (!args.role) args.role = a;
    else throw new Error(`多余的参数：${a}`);
  }

  return args;
}

/* ============================================================
   改角色
   ============================================================ */

/**
 * 改角色的全部规则，纯粹、可测。
 *
 * @returns {{ok:true, user, from, to}} 或 {{ok:false, reason, message}}
 */
export function setRole(repo, { openid, role }) {
  if (!openid) return { ok: false, reason: 'no_openid', message: '没给 openid' };

  if (!ASSIGNABLE.includes(role)) {
    if (role === 'owner') {
      return {
        ok: false, reason: 'use_owner_script',
        message: '超管不能用这个脚本设 —— 用 scripts/set-owner.mjs（只在还没有超管时生效），\n'
          + '    之后换届请在小程序里走「转交超管」',
      };
    }
    return {
      ok: false, reason: 'bad_role',
      message: `角色只能是 ${ASSIGNABLE.join(' / ')}（超管另有专门的方式）`,
    };
  }

  const user = repo.findUserByOpenid(openid);
  if (!user) {
    return {
      ok: false, reason: 'not_found',
      message: `找不到 openid 为 ${openid} 的账号。\n`
        + '    先让他在手机上完成登记，再跑 --list 看看 —— '
        + '注意开发者工具里那个假 openid 和手机上的真实 openid 不是一回事。',
    };
  }

  // ★ 不许动现任超管。repository.setUserRole 本身只拒绝「设成 owner」，
  //   并不拒绝「把 owner 改成别的」—— 从接口走有 roles.mjs 的策略挡着，
  //   而脚本是直接调数据层的，那道策略不经过。
  //   真把超管降级了，系统会变成「零个超管」：接口再也转交不了，
  //   只能靠 set-owner 重新设立一次。
  if (user.role === 'owner') {
    return {
      ok: false, reason: 'owner_immutable',
      message: `${user.name} 是现任超管，不能在这里改。\n`
        + '    换届请让他本人在小程序里走「转交超管」。',
    };
  }

  const r = repo.setUserRole(user.id, role);
  if (!r.ok) return { ok: false, reason: r.reason, message: `改不了：${r.reason}` };

  return { ok: true, user: r.user, from: r.from, to: r.to };
}

/* ============================================================
   CLI
   ============================================================ */

const fmtRole = (role) => `${ROLE_LABEL[role] || '未知角色'}（${role}）`;

export function run({ argv = [], env = {}, out = console.log, err = console.error } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`[x] ${e.message}\n\n${USAGE}`);
    return 1;
  }

  if (args.help) {
    out(USAGE);
    return 0;
  }

  const dbPath = env.DB_PATH || PROD_DB_PATH;
  const db = openMigrated(dbPath);
  const repo = createSqliteRepository(db);

  try {
    const users = repo.listUsers();

    if (args.list || !args.openid) {
      out(`数据库：${dbPath}\n`);
      if (!users.length) {
        out('还没有任何已登记的账号。先在手机上完成登记，再回来跑这个脚本。');
      } else {
        out('已登记的账号（要用 openid 选人）：');
        for (const u of users) {
          // 昵称放前面 —— 找「手机上那个人是哪一行」看的就是昵称。
          // ★ 不做对齐：padEnd 数的是 UTF-16 长度，中文标签的显示宽度不一样，
          //   强行补齐只会补出一堆看着像对不齐的空格。
          out(`  ${u.name}  ${fmtRole(u.role)}`);
          out(`      openid: ${u.openid}`);
        }
      }
      if (!args.openid) {
        out(`\n用法：node scripts/set-role.mjs <openid> <角色>`);
        out(`角色：${ASSIGNABLE.join(' / ')}`);
        return 0;
      }
    }

    if (!args.role) {
      err(`[x] 要给 ${args.openid} 设成什么角色？\n\n${USAGE}`);
      return 1;
    }

    const r = setRole(repo, args);
    if (!r.ok) {
      err(`[x] ${r.message}`);
      return 1;
    }

    repo.writeAudit({
      actorId: null, action: 'role.change',
      targetType: 'user', targetId: r.user.id,
      detail: { from: r.from, to: r.to, via: 'scripts/set-role.mjs' },
    });

    out(`✅ ${r.user.name}：${r.from} → ${r.to}（${ROLE_LABEL[r.to] || r.to}）`);
    out('   他需要**重新进一次「我的」页**才会看到新入口 ——');
    out('   那一页每次显示都会拉一次最新角色，不用清缓存、不用重新登记。');
    return 0;
  } finally {
    db.close();
  }
}

function main() {
  process.exitCode = run({ argv: process.argv.slice(2), env: process.env });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
