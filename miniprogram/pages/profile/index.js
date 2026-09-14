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
    // 登记表单
    needRegister: false,
    sid: '',
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
  },

  refresh() {
    const user = session.getUser();
    this.setData({
      user,
      isStaff: session.isStaff(),
      needRegister: !user,
    });
  },

  onSidInput(e) { this.setData({ sid: e.detail.value }); },
  onNameInput(e) { this.setData({ name: e.detail.value }); },
  toggleAgree() { this.setData({ agree: !this.data.agree }); },

  async submitRegister() {
    const sid = String(this.data.sid || '').trim();
    const name = String(this.data.name || '').trim();

    // 前端校验只是为了少一次往返，真正的约束在服务端（唯一索引）
    if (!/^\d{6,16}$/.test(sid)) {
      return wx.showToast({ title: '请输入 6–16 位数字学号', icon: 'none' });
    }
    if (name.length < 2 || name.length > 12) {
      return wx.showToast({ title: '请输入真实姓名', icon: 'none' });
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
      await session.register(sid, name);
      wx.showToast({ title: '登记成功', icon: 'success' });
      this.setData({ sid: '', name: '', agree: false });
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

  goItems() {
    wx.navigateTo({ url: '/packageBazaar/pages/items/index' });
  },

  remindRegister() {
    wx.showToast({ title: '请先登记学号姓名', icon: 'none' });
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
