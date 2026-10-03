import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import { quotaText, quotaLevel, quotaPercent, groupCode, imageUrl } from '../../../utils/format.js';

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
        this.setData({ error: '这件物品不存在或已下架' });
        return;
      }
      const stalls = r.stalls || [];
      const user = session.getUser();

      this.setData({
        item: { ...item, imageUrl: imageUrl(item) },
        stall: stalls.find((s) => s.id === item.stallId) || null,
        quotaText: quotaText(item),
        level: quotaLevel(item),
        percent: quotaPercent(item),
        maxQty: Math.max(1, Math.min(item.remainingQuota, 5)),
        // sid 现在是可选的（学生端已不再收集），所以必须能显示成「只有昵称」
        userLabel: user ? (user.sid ? `${user.name}（${user.sid}）` : user.name) : '未登记',
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
    this.setData({ showSheet: true, qty: 1 });
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
    this.setData({ submitting: true });

    try {
      const r = await api.post('/api/reserve', {
        token: session.getToken(),
        body: {
          itemId: this.data.id,
          qty: this.data.qty,
          requestId: this.requestId,
        },
      });

      this.setData({ showSheet: false });
      wx.navigateTo({
        url: `/packageBazaar/pages/pickup-code/index?id=${r.reservation.id}&fresh=1`,
      });
    } catch (e) {
      // 业务失败（约满、重复预定）服务端已经给了文案，直接弹
      wx.showToast({ title: (e && e.message) || '预定失败', icon: 'none' });
      // 约满或重复预定后刷新一下真实状态，别让用户对着过期数字发呆
      if (e && e.business) this.load();
    } finally {
      this.setData({ submitting: false });
    }
  },
});
