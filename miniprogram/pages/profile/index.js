/**
 * 我的 —— 兼身份登记页。
 *
 * 没登记时直接在这里登记，不再单独开一个页面：
 * 少一跳，而且用户本来就会来「我的」找自己的信息。
 */
import * as session from '../../services/session.js';
import * as api from '../../services/api.js';
import { imageUrl } from '../../utils/format.js';
import { pickAndUploadImage, reportImageResult } from '../../utils/image-upload.js';

Page({
  data: {
    user: null,
    isStaff: false,
    isManager: false,
    roleText: '学生',
    // 头像：没有头像时回落成昵称首字（和猫图鉴没照片时回落 emoji 同一个套路）
    avatarUrl: '',
    avatarText: '',
    avatarFailed: false,
    // 登记表单
    needRegister: false,
    name: '',
    submitting: false,
    agree: false,
    // 登记失败的原因。★ 不只弹 toast —— 见 submitRegister 里的说明
    regError: '',
  },

  // ★ 这里原来有个 onLoad 读 query.register —— 是死代码：
  //   「我的」是 tabBar 页面，只能 switchTab 进来，而 switchTab 带不了 query。
  //   登记表单由下面的 refresh() 打开（needRegister = !user）。
  onShow() {
    this.refresh();
    this.syncRole();
    this.ensureProfile();
  },

  /**
   * 本地没有登录态时**先静默登录一次**，再决定显示什么。
   *
   * ★ 为什么必须有：退出登录（或清了缓存）之后本地没有 user，
   *   而表单的显示规则是 `needRegister = !user` —— 于是**登记过的人**也会看到
   *   「填写昵称」，看着像要重新登记；可实际上 openid 一登录就把原账号找回来，
   *   真去填还会被告知「已经登记过了」。白白让人多操作一轮。
   *
   *   「未登录」和「未登记」是两件事：
   *     · 未登录 = 本机没 token（会自动恢复，不该打扰人）
   *     · 未登记 = 服务端没有这个 openid 的账号（才需要填昵称）
   */
  async ensureProfile() {
    if (session.getUser() && session.getToken()) return;

    try {
      const r = await session.login();     // 静默：不弹任何东西
      if (r && r.registered) this.refresh();
    } catch {
      // 登录失败就保持表单 —— 至少还能手动填一次，不至于整页空白
    }
    this.refresh();
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
    } catch {
      // 静默：网络抖动就继续用缓存里的角色。
      // ★ 但 401 时 refreshUser 已经把登录态清掉了 —— 那时必须重画一次，
      //   否则页面还挂着「已登录」的样子，而每个请求都被拒。
    }
    this.refresh();
  },

  refresh() {
    const user = session.getUser();
    this.setData({
      user,
      isStaff: session.isStaff(),
      isManager: session.isManager(),
      isSeniorManager: session.isSeniorManager(),
      roleText: session.roleLabel(user),
      needRegister: !user,
      avatarUrl: user && user.avatar ? imageUrl({ image: user.avatar }) : '',
      avatarText: user && user.name ? String(user.name).slice(0, 1) : '🎪',
    });
  },

  /** 点头像 → 选图 → 上传（学生也能改自己的） */
  async changeAvatar() {
    if (!this.data.user) return undefined;

    // ★ 先确认服务端认这个 token：本地有 token 不代表它还有效
    //   （过期，或服务端换过签名密钥）。否则就是「看起来登录了，传什么都 401」。
    try {
      await session.ensureSession({ verify: true });
    } catch (e) {
      session.handleError(e);
      this.refresh();
      return undefined;
    }

    const up = await pickAndUploadImage({
      token: session.getToken(),
      endpoint: '/api/me/avatar',
      // 头像统一裁成 1:1：原生裁剪界面（wx.cropImage，基础库 2.26+，低版本自动跳过）
      crop: '1:1',
    });
    if (!up.ok) {
      reportImageResult(up);
      return undefined;
    }
    // 先用本地临时图顶上（不用等一次往返），再拉一次资料换成正式地址
    this.setData({ avatarUrl: up.previewPath, avatarFailed: false });
    try {
      await session.refreshUser();
    } catch { /* 拉不到就先显示本地图，下次进页面会补上 */ }
    this.refresh();
    return undefined;
  },

  /** 改昵称：注册之后唯一能改的资料（以前填错只能找管理员改库） */
  async rename() {
    const old = (this.data.user && this.data.user.name) || '';
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '改昵称',
        editable: true,
        placeholderText: '1–16 个字，现场核对取货人用',
        content: old,
        success: (r) => resolve(r && r.confirm ? String(r.content || '').trim() : null),
        fail: () => resolve(null),
      });
    });
    if (res === null) return undefined;              // 取消了
    if (!res) return wx.showToast({ title: '昵称不能为空', icon: 'none' });

    try {
      await session.ensureSession({ verify: true });
      const r = await api.post('/api/me/name', { token: session.getToken(), body: { name: res } });
      session.setUser(r.user);
      this.refresh();
      wx.showToast({ title: '已改', icon: 'success' });
    } catch (e) {
      session.handleError(e);
    }
    return undefined;
  },

  /** 不要头像了 —— 回落到昵称首字 */
  async clearAvatar() {
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '去掉头像？',
        content: '会显示成你昵称的第一个字。',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!res) return undefined;

    try {
      await api.post('/api/me/avatar', { token: session.getToken(), body: { image: null } });
      await session.refreshUser();
      this.refresh();
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '没改成功', icon: 'none' });
    }
    return undefined;
  },

  onAvatarError() {
    if (!this.data.avatarFailed) this.setData({ avatarFailed: true });
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

  /** 图鉴管理。志愿者及以上（服务端也是这么卡的）—— 照片要能在校园里随手传。 */
  goAdminCats() {
    if (!this.data.isStaff) return;
    wx.navigateTo({ url: '/packageAdmin/pages/cats/index' });
  },

  /** 角色管理。一级管理员及以上。 */
  /** 本届负责人：只读名单，谁都能看（未登记的人在「我的」页只有登记表单，进不来） */
  goMembers() {
    if (!this.data.user) return;
    wx.navigateTo({ url: '/pages/members/index' });
  },

  goAdminRoles() {
    if (!this.data.isSeniorManager) return;
    wx.navigateTo({ url: '/packageAdmin/pages/roles/index' });
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
      title: '清除本机缓存',
      // ★ 这句原来是「退出后需要重新登记才能预定名额」—— **是假的**。
      //   这里只清本机的 token 和缓存；服务端的账号还在，openid 一登录就把它找回来。
      content: '只清掉这台手机上的登录状态，账号和已定的名额都还在，再次进入会自动登录。确定吗？',
      success: (res) => {
        if (!res.confirm) return;
        session.clearSession();
        this.refresh();
        wx.showToast({ title: '已清除', icon: 'none' });
        // 紧接着静默登录一次：openid 没变，账号马上就回来了，
        // 不会让登记过的人对着「填写昵称」发愣
        this.ensureProfile();
      },
    });
  },
});
