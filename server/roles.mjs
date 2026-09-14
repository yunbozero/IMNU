/**
 * 角色与权限策略。
 *
 * ★ 单独抽成一个纯模块，因为它是最该被穷举测试的东西：
 *   权限判断写错的后果不是"界面难看"，而是"有人能删掉不该删的人"或者
 *   "没人能撤销已经毕业的账号"。这里每一个组合都由测试钉死。
 *
 * 层级（按讨论定的规则）：
 *   owner  超管        全局唯一，不可通过界面撤销，只能「转交」
 *   admin  一级管理员   可任命一级和二级，但只能撤销二级及以下
 *   deputy 二级管理员   无权撤销管理员
 *   volunteer 志愿者    只能核销
 *   student 学生        只能浏览和预定
 *
 * 讨论里没明确的部分（比如二级管理员能不能任命志愿者），
 * 我按**最小权限**处理：只给必要的，没说的不给。
 */

export const ROLES = ['student', 'volunteer', 'deputy', 'admin', 'owner'];

/** 数值越大权限越高。用来做「只能管比自己低的」这类判断。 */
export const RANK = {
  student: 0,
  volunteer: 1,
  deputy: 2,
  admin: 3,
  owner: 4,
};

export const ROLE_LABEL = {
  student: '学生',
  volunteer: '志愿者',
  deputy: '二级管理员',
  admin: '一级管理员',
  owner: '超级管理员',
};

export const isRole = (r) => ROLES.includes(r);

/** 能进核销台的角色 */
export const canRedeem = (role) => RANK[role] >= RANK.volunteer;

/** 能进管理后台的角色 */
export const canManage = (role) => RANK[role] >= RANK.deputy;

/**
 * 任命规则。
 *
 * 注意 admin 可以任命 admin —— 这是有意为之：换届时要有多个一级管理员
 * 一起干活。代价是"一级管理员只能被超管撤销"，所以超管的转交功能是必须的，
 * 否则超管毕业之后就没人能清理了。
 */
const GRANT = {
  owner: ['admin', 'deputy', 'volunteer'],
  admin: ['admin', 'deputy', 'volunteer'],
  deputy: ['volunteer'],
  volunteer: [],
  student: [],
};

/**
 * 撤销规则。
 * 和任命刻意不对称：**admin 不能撤销 admin**，
 * 这样多个一级管理员之间不能互相清洗。
 */
const REVOKE = {
  owner: ['admin', 'deputy', 'volunteer'],
  admin: ['deputy', 'volunteer'],
  deputy: ['volunteer'],
  volunteer: [],
  student: [],
};

export const canGrant = (actorRole, targetRole) =>
  (GRANT[actorRole] || []).includes(targetRole);

export const canRevoke = (actorRole, targetRole) =>
  (REVOKE[actorRole] || []).includes(targetRole);

/** 只有超管能把超管身份转交出去 */
export const canTransferOwner = (actorRole) => actorRole === 'owner';

/**
 * 一次「改角色」的完整判定。
 * 把不变式集中在这里，接口层只管调它。
 *
 * @returns {{ok: true} | {ok: false, reason: string, message: string}}
 */
export function checkRoleChange({
  actorRole, actorId, targetRole, targetId, nextRole,
}) {
  if (!isRole(actorRole)) return deny('bad_actor', '当前身份无法执行这个操作');
  if (!isRole(targetRole)) return deny('bad_target', '目标身份不合法');
  if (!isRole(nextRole)) return deny('bad_role', '要设置的身份不合法');

  // 超管的身份只能通过「转交」变更。允许直接改的话，
  // 一次误操作就可能让整个系统没有超管。
  if (targetRole === 'owner') {
    return deny('owner_immutable', '超管身份只能转交，不能直接修改');
  }
  if (nextRole === 'owner') {
    return deny('use_transfer', '提升为超管请走「转交超管」流程');
  }

  // 不能动自己。否则超管一次误点就把自己降级了，系统从此没有超管。
  if (actorId && targetId && actorId === targetId) {
    return deny('self_change', '不能修改自己的身份');
  }

  const isPromotion = RANK[nextRole] > RANK[targetRole];

  if (isPromotion) {
    if (!canGrant(actorRole, nextRole)) {
      return deny('forbidden',
        `以${ROLE_LABEL[actorRole]}的身份不能任命${ROLE_LABEL[nextRole]}`);
    }
    // 只能任免比自己低的角色。唯一例外是 admin 可以任命 admin（见上面注释）
    if (RANK[nextRole] >= RANK[actorRole] && actorRole !== 'owner' && nextRole !== 'admin') {
      return deny('forbidden', '不能任命权限不低于自己的角色');
    }
  } else {
    if (!canRevoke(actorRole, targetRole)) {
      return deny('forbidden',
        `以${ROLE_LABEL[actorRole]}的身份不能撤销${ROLE_LABEL[targetRole]}`);
    }
  }

  return { ok: true };
}

/** 转交超管的判定 */
export function checkOwnerTransfer({ actorRole, actorId, targetId }) {
  if (!canTransferOwner(actorRole)) return deny('forbidden', '只有超管可以转交');
  if (!targetId) return deny('bad_target', '请选择交接给谁');
  if (actorId && actorId === targetId) return deny('self_transfer', '不能转交给自己');
  return { ok: true };
}

function deny(reason, message) {
  return { ok: false, reason, message };
}

/**
 * 完整性自检：任何角色都不该能任命/撤销 owner，
 * 也不该能任命权限不低于自己的角色（admin→admin 是明确允许的例外）。
 * 由测试调用。
 */
export function auditPolicy() {
  const problems = [];

  for (const actor of ROLES) {
    if (canGrant(actor, 'owner')) problems.push(`${actor} 竟然能任命超管`);
    if (canRevoke(actor, 'owner')) problems.push(`${actor} 竟然能撤销超管`);

    for (const target of GRANT[actor] || []) {
      if (target === 'admin' && actor !== 'owner') continue;   // 明确允许
      if (RANK[target] >= RANK[actor]) {
        problems.push(`${actor} 能任命不低于自己的 ${target}`);
      }
    }
    for (const target of REVOKE[actor] || []) {
      if (RANK[target] >= RANK[actor]) {
        problems.push(`${actor} 能撤销不低于自己的 ${target}`);
      }
    }
  }

  return problems;
}
