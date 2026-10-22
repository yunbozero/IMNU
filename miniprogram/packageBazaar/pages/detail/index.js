import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import { platform } from '../../../services/platform.js';
import { quotaText, quotaLevel, quotaPercent, groupCode, imageUrl } from '../../../utils/format.js';

/**
 * 活动口令的本地缓存。**按活动 id 分开存** —— 换一场活动就是新口令，
 * 拿上一场记住的口令去顶只会让用户莫名被拒。
 *
 * 只在服务端认过之后才写；服务端说不对就删掉，重新显示输入栏。
 */
const passKey = (eventId) => `pass:${eventId}`;
const readCachedPass = (eventId) => (eventId ? (platform().getStorage(passKey(eventId)) || '') : '');
const writeCachedPass = (eventId, pass) => {
  if (eventId && pass) platform().setStorage(passKey(eventId), pass);
};
const clearCachedPass = (eventId) => {
  if (eventId) platform().removeStorage(passKey(eventId));
};

Page({
  data: {
    id: '',
    loading: true,
    error: '',

    item: null,
    stall: null,
    quotaText: '',
    level: '',
    percent: 0,

    // 确认预定弹层
    showSheet: false,
    qty: 1,
    maxQty: 1,
    userLabel: '',
    submitting: false,

    // 活动口令：只有这场活动设了口令、而且本机还没通过时才显示输入栏
    passRequired: false,
    needPass: false,
    pass: '',
    passError: '',
    eventId: '',

    // 已经预定过这件物品时，底部按钮变成「查看取货码」
    myReservation: null,

    // 照片加载失败过 —— 回落到 emoji（和列表页同一个套路）
    imageFailed: false,
  },

  onLoad(query) {
    this.setData({ id: (query && query.id) || '' });
    // ★ 幂等键在「打开弹层」时生成一次，同一次提交内反复重试都用它。
    //   这样网络超时后用户再点一次，也不会产生第二笔预定。
    this.requestId = null;
    this.load();
  },

  onShow() {
    // 从取货码页返回时刷新一下状态
    if (!this.data.loading) this.load();
  },

  async load() {
    this.setData({ error: '' });
    try {
      const r = await api.get('/api/items');
      const item = (r.items || []).find((x) => x.id === this.data.id);
      if (!item) {
        this.setData({ error: '这件物品不存在或已关闭预定' });
        return;
      }
      const stalls = r.stalls || [];
      const user = session.getUser();

      // ★ 口令按**活动**缓存：换一场活动就是新口令，不能拿上一场的去顶。
      //   只有「服务端认了」才写缓存；服务端不认就删掉、重新显示输入栏。
      const ev = r.event || null;
      const cachedPass = ev && ev.passRequired ? readCachedPass(ev.id) : '';

      this.setData({
        item: { ...item, imageUrl: imageUrl(item) },
        stall: stalls.find((s) => s.id === item.stallId) || null,
        quotaText: quotaText(item),
        level: quotaLevel(item),
        percent: quotaPercent(item),
        maxQty: Math.max(1, Math.min(item.remainingQuota, 5)),
        // sid 现在是可选的（学生端已不再收集），所以必须能显示成「只有昵称」
        userLabel: user ? (user.sid ? `${user.name}（${user.sid}）` : user.name) : '未登记',
        eventId: ev ? ev.id : '',
        passRequired: !!(ev && ev.passRequired),
        pass: cachedPass,
        needPass: !!(ev && ev.passRequired) && !cachedPass,
      });

      await this.loadMyReservation();
    } catch (e) {
      this.setData({ error: e.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadMyReservation() {
    if (!session.getUser()) return;
    try {
      const r = await api.get('/api/reservations', { token: session.getToken() });
      const mine = (r.reservations || []).find(
        (x) => x.itemId === this.data.id && x.status === 'reserved'
      );
      this.setData({ myReservation: mine || null });
    } catch {
      // 拿不到就算了，不影响看物品
    }
  },

  async onPrimaryTap() {
    if (this.data.myReservation) {
      wx.navigateTo({
        url: `/packageBazaar/pages/pickup-code/index?id=${this.data.myReservation.id}`,
      });
      return;
    }
    if (this.data.item.remainingQuota <= 0) return;

    // 预定需要身份，没有就先去登记
    if (!session.getUser()) {
      try {
        await session.ensureSession();
        const u = session.getUser();
        this.setData({ userLabel: u.sid ? `${u.name}（${u.sid}）` : u.name });
      } catch (e) {
        return session.handleError(e);
      }
    }

    this.requestId = api.genRequestId();
    // 需要口令、又还没通过过 → 弹层里直接显示输入栏
    this.setData({
      showSheet: true,
      qty: 1,
      passError: '',
      needPass: this.data.passRequired && !this.data.pass,
    });
  },

  onPassInput(e) {
    this.setData({ pass: e.detail.value, passError: '' });
  },

  closeSheet() {
    if (this.data.submitting) return;
    this.setData({ showSheet: false });
  },

  /** 照片加载失败 → 大图和弹层里的小图都回落到 emoji */
  onImageError() {
    if (!this.data.imageFailed) this.setData({ imageFailed: true });
  },

  noop() { /* 阻止弹层内部点击冒泡到遮罩 */ },

  decQty() {
    if (this.data.qty > 1) this.setData({ qty: this.data.qty - 1 });
  },

  incQty() {
    if (this.data.qty < this.data.maxQty) this.setData({ qty: this.data.qty + 1 });
  },

  async confirmReserve() {
    if (this.data.submitting) return;

    // 需要口令但还没填：不发请求，就地提示（别用 toast，输入栏就在眼前）
    if (this.data.needPass && !String(this.data.pass || '').trim()) {
      return this.setData({ passError: '请先填活动口令（在摊位海报或班群里）' });
    }

    this.setData({ submitting: true });

    try {
      const r = await api.post('/api/reserve', {
        token: session.getToken(),
        body: {
          itemId: this.data.id,
          qty: this.data.qty,
          requestId: this.requestId,
          // 服务端设了口令才带；没设的话多带一个字段也没意义
          ...(this.data.passRequired ? { pass: String(this.data.pass || '').trim() } : {}),
        },
      });

      // 服务端认了才缓存 —— 下次预定不再问
      if (this.data.passRequired) writeCachedPass(this.data.eventId, String(this.data.pass).trim());

      this.setData({ showSheet: false });
      wx.navigateTo({
        url: `/packageBazaar/pages/pickup-code/index?id=${r.reservation.id}&fresh=1`,
      });
    } catch (e) {
      const code = (e && e.code) || '';

      // 口令不对 / 没带：清掉缓存、就地显示输入栏 —— 弹层不关，用户只改一个字
      if (code === 'pass_wrong' || code === 'pass_required') {
        clearCachedPass(this.data.eventId);
        return this.setData({
          needPass: true,
          passError: (e && e.message) || '活动口令不对，再试一次',
        });
      }
      if (code === 'pass_locked') {
        return this.setData({ passError: (e && e.message) || '口令试错太多次了，稍后再来' });
      }

      // 业务失败（约满、重复预定、上一场没取被降权）服务端已经给了文案，直接弹
      wx.showToast({ title: (e && e.message) || '预定失败', icon: 'none' });
      // 约满或重复预定后刷新一下真实状态，别让用户对着过期数字发呆
      if (e && e.business) this.load();
    } finally {
      this.setData({ submitting: false });
    }
  },
});
