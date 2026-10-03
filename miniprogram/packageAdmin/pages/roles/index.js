/**
 * 管理端 · 角色管理（提权 / 撤销 / 转交超管）。
 *
 * 为什么要有这一页：在这之前，小程序里**根本没有任何任命角色的入口** ——
 * 接口 `POST /api/admin/role` 和 `POST /api/admin/transfer-owner` 早就写好了、
 * 也有穷举测试，但界面一直没做。于是「给志愿者开核销权限」只能 SSH 上服务器跑脚本，
 * 而**换届转交超管彻底做不到**：set-role 拒绝设 owner，set-owner 在已有超管时也拒绝，
 * 界面又没有入口 —— 现任超管一毕业，系统就永远卡在他身上。
 *
 * ★ 界面**不做任何权限判断**。服务端在 /api/admin/users 里逐行算好了
 *   `settable`（这个人能被改成哪些角色）和 `canTransferOwner`，
 *   这里只负责把它们画成按钮。规则只有 roles.mjs 那一处 ——
 *   界面自己判断一遍的话，必然出现「显示了按钮但点了被拒」或者反过来，
 *   而这两种都只在特定角色组合下发生，手测基本撞不到。
 *
 * 门槛：一级管理员及以上（和服务端的 isSeniorManager 一致）。
 * 副主任也能调 adminSetRole（他能任命志愿者），但那一档太窄，
 * 不值得为它多开一页入口。
 */
import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';

/** 角色的显示顺序：从低到高，写死的，只影响列表排序 */
const RANK = { owner: 0, admin: 1, deputy: 2, volunteer: 3, student: 4 };

Page({
  data: {
    loading: true,
    error: '',
    busyId: '',
    list: [],
    // 我自己是不是超管 —— 决定要不要显示「转交超管」
    iAmOwner: false,
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ error: '' });

    try {
      await session.ensureSession();

      if (!session.isSeniorManager()) {
        this.setData({ error: '这个页面只有一级管理员及以上能进' });
        return;
      }

      this.me = session.getUser();
      const r = await api.get('/api/admin/users', { token: session.getToken() });

      // 超管排最前面，然后按级别；同级别按昵称，顺序稳定才好看
      const list = (r.users || []).slice().sort((a, b) => {
        const ra = RANK[a.role] === undefined ? 9 : RANK[a.role];
        const rb = RANK[b.role] === undefined ? 9 : RANK[b.role];
        if (ra !== rb) return ra - rb;
        return String(a.name).localeCompare(String(b.name), 'zh');
      });

      this.setData({
        list,
        iAmOwner: !!(this.me && this.me.role === 'owner'),
      });
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 改角色。`role` 来自服务端算好的 settable，界面不判断合法性。 */
  async setRole(e) {
    const { id, role, name } = e.currentTarget.dataset;
    if (this.data.busyId) return false;

    const label = this.data.list.find((u) => u.id === id);
    const to = label && label.settableLabels
      ? label.settableLabels[label.settable.indexOf(role)] : role;

    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: `${name} → ${to}？`,
        content: role === 'student'
          ? '会撤掉他的全部管理权限。'
          : '改完立刻生效，他重新进一次「我的」页就能看到新入口。',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!ok) return false;

    return this.post('/api/admin/role', { userId: id, role },
      role === 'student' ? '已撤销权限' : `已设为${to}`);
  },

  /**
   * 转交超管。**不可逆，而且自己会变成一级管理员** —— 所以文案必须说清，
   * 并让他在弹窗里把目标名字再确认一次。
   */
  async transfer(e) {
    const { id, name } = e.currentTarget.dataset;
    if (this.data.busyId) return false;

    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: `把超管交给「${name}」？`,
        content: '你自己会变成一级管理员，而且这一步小程序里撤不回来。'
          + '确认对方是你信任的下一届负责人。',
        confirmText: '转交',
        confirmColor: '#C6432F',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!ok) return false;

    return this.post('/api/admin/transfer-owner', { userId: id }, '已转交');
  },

  /** 两个写操作共用的出口：成功后整页重拉 —— 权限变了，别人的按钮也会跟着变 */
  async post(path, body, toast) {
    this.setData({ busyId: body.userId });
    try {
      await api.post(path, { token: session.getToken(), body });
      wx.showToast({ title: toast, icon: 'success' });
      await this.load();
      return true;
    } catch (err) {
      session.handleError(err);
      return false;
    } finally {
      this.setData({ busyId: '' });
    }
  },
});
