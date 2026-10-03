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
    // 登记失败的原因。★ 不只弹 toast —— 见 submitRegister 里的说明
    regError: '',
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

  onNameInput(e) { this.setData({ name: e.detail.value, regError: '' }); },
  toggleAgree() { this.setData({ agree: !this.data.agree, regError: '' }); },

  async submitRegister() {
    const name = String(this.data.name || '').trim();

    // 前端校验只是为了少一次往返，真正的约束在服务端。
    // ★ 不再收学号：既然没法在小程序里验证身份，收一个验证不了的学号
    //   只会让人以为验过了，还多一份隐私负担。
    if (name.length < 1 || name.length > 16) {
      return this.failRegister('请填写 1–16 个字的昵称');
    }
    if (!this.data.agree) {
      return this.failRegister('请先勾选同意活动规则');
    }

    this.setData({ submitting: true, regError: '' });
    try {
      // 需要 register 作用域的 token。手上没有就先登录一次。
      if (session.getScope() !== 'register') {
        const r = await session.login();
        if (r.registered) {
          // ★ 这里以前是**静默 return**：账号其实早就存在（退出登录之后又想来登记、
          //   或者换了个调试会话、本地缓存被清了），用户点「完成登记」屏幕毫无反应，
          //   看起来就是「昵称提交不了」。任何出口都必须说一句话。
          wx.showToast({ title: '这个微信号已经登记过了', icon: 'none' });
          this.refresh();
          return;
        }
      }
      await session.register(name);
      wx.showToast({ title: '登记成功', icon: 'success' });
      this.setData({ name: '', agree: false, regError: '' });
      this.refresh();
    } catch (e) {
      this.failRegister((e && e.message) || '登记失败', e && e.code);
    } finally {
      this.setData({ submitting: false });
    }
  },

  /**
   * 登记失败：**留在屏幕上**，而不是只弹一下 toast。
   *
   * ★ toast 一两秒就没了，而登记失败是用户必须看懂的信息。真机上出问题时，
   *   人往往截不到那一下，只能在「点了没反应」和「报错了」之间猜 ——
   *   结果就是「昵称提交不了」这种没法查的描述。
   *
   * 后面括起来的是错误码：`network`（请求没发出去/没回来）和 `unauthorized`（401）
   * 的排查方向完全不同，把它显示出来能省一整轮来回。
   */
  failRegister(message, code) {
    const text = code ? `${message}（${code}）` : message;
    this.setData({ regError: text });
    wx.showToast({ title: message, icon: 'none' });
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

  /**
   * 活动与摊位。入口对副主任管理员就开 —— 那一页里再分一次：
   * 副主任能建摊位，只有一级管理员能看到建/结束活动的部分。
   * （和服务端的门槛一一对应：摊位 deputy+、活动 admin+）
   */
  goAdminEvent() {
    if (!this.data.isManager) return;
    wx.navigateTo({ url: '/packageAdmin/pages/event/index' });
  },

  /** 图鉴照片。和物品照片同一档（副主任及以上），服务端也是这么卡的。 */
  goAdminCats() {
    if (!this.data.isManager) return;
    wx.navigateTo({ url: '/packageAdmin/pages/cats/index' });
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
      // ★ 这句原来是「退出后需要重新登记才能预定名额」—— **是假的**。
      //   退出只清本机的 token 和缓存；服务端的账号还在，openid 一登录就把它找回来，
      //   下次进来会自动登录，昵称和已定的名额都原样在。
      //   照着旧文案理解，用户会以为「退出 = 换一个昵称重新登记」，
      //   结果点完发现还是老账号，白折腾一轮。
      content: '退出只是清掉本机的登录状态，账号和已定的名额都还在，再次进入会自动登录。确定吗？',
      success: (res) => {
        if (!res.confirm) return;
        session.clearSession();
        this.refresh();
        wx.showToast({ title: '已退出', icon: 'none' });
      },
    });
  },
});
