/**
 * 我的 —— 兼身份登记页。
 *
 * 没登记时直接在这里登记，不再单独开一个页面：
 * 少一跳，而且用户本来就会来「我的」找自己的信息。
 */
import * as session from '../../services/session.js';

Page({
  data: {
    user: null,
    isStaff: false,
    isManager: false,
    roleText: '学生',
    // 登记表单
    needRegister: false,
    name: '',
    submitting: false,
    agree: false,
  },

  onLoad(query) {
    if (query && query.register === '1') {
      this.setData({ needRegister: true });
    }
  },

  onShow() {
    this.refresh();
    this.syncRole();
  },

  /**
   * 角色可能被管理员改过（提成志愿者、给管理权限），而客户端缓存里还是旧的 ——
   * 不拉一次的话，管理端和核销台的入口**永远不出现**。
   *
   * 义卖当天尤其要紧：现场给志愿者开权限，他总不能清缓存重来。
   *
   * 拉失败就继续用缓存，不打扰用户 —— 网络抖动或 token 过期都会走到这里。
   */
  async syncRole() {
    if (!session.getUser() || !session.getToken()) return;
    try {
      await session.refreshUser();
      this.refresh();
    } catch {
      // 静默：用缓存里的角色继续显示
    }
  },

  refresh() {
    const user = session.getUser();
    this.setData({
      user,
      isStaff: session.isStaff(),
      isManager: session.isManager(),
      roleText: session.roleLabel(user),
      needRegister: !user,
    });
  },

  onNameInput(e) { this.setData({ name: e.detail.value }); },
  toggleAgree() { this.setData({ agree: !this.data.agree }); },

  async submitRegister() {
    const name = String(this.data.name || '').trim();

    // 前端校验只是为了少一次往返，真正的约束在服务端。
    // ★ 不再收学号：既然没法在小程序里验证身份，收一个验证不了的学号
    //   只会让人以为验过了，还多一份隐私负担。
    if (name.length < 1 || name.length > 16) {
      return wx.showToast({ title: '请填写 1–16 个字的昵称', icon: 'none' });
    }
    if (!this.data.agree) {
      return wx.showToast({ title: '请先勾选同意活动规则', icon: 'none' });
    }

    this.setData({ submitting: true });
    try {
      // 需要 register 作用域的 token。手上没有就先登录一次。
      if (session.getScope() !== 'register') {
        const r = await session.login();
        if (r.registered) { this.refresh(); return; }
      }
      await session.register(name);
      wx.showToast({ title: '登记成功', icon: 'success' });
      this.setData({ name: '', agree: false });
      this.refresh();
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '登记失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  goMyReservations() {
    if (!this.data.user) return this.remindRegister();
    wx.navigateTo({ url: '/packageBazaar/pages/my-reservations/index' });
  },

  goScan() {
    wx.navigateTo({ url: '/packageBazaar/pages/scan/index' });
  },

  goAdmin() {
    if (!this.data.isManager) return;
    wx.navigateTo({ url: '/packageAdmin/pages/reservations/index' });
  },

  goAdminItems() {
    if (!this.data.isManager) return;
    wx.navigateTo({ url: '/packageAdmin/pages/items/index' });
  },

  goItems() {
    wx.navigateTo({ url: '/packageBazaar/pages/items/index' });
  },

  remindRegister() {
    wx.showToast({ title: '请先填写昵称', icon: 'none' });
    this.setData({ needRegister: true });
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新登记才能预定名额。确定吗？',
      success: (res) => {
        if (!res.confirm) return;
        session.clearSession();
        this.refresh();
        wx.showToast({ title: '已退出', icon: 'none' });
      },
    });
  },
});
