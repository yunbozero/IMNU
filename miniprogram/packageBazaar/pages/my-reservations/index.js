import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import { statusText, statusClass, groupCode, timeText } from '../../../utils/format.js';

const TABS = [
  { key: 'reserved', label: '待取货' },
  { key: 'redeemed', label: '已取货' },
  { key: 'cancelled', label: '已取消' },
];

Page({
  data: {
    tabs: TABS,
    active: 'reserved',
    loading: true,
    error: '',
    all: [],
    list: [],
    pendingCount: 0,
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
      const r = await api.get('/api/reservations', { token: session.getToken() });

      const all = (r.reservations || []).map((x) => ({
        ...x,
        codeText: groupCode(x.code),
        statusText: statusText(x.status),
        statusClass: statusClass(x.status),
        subText: this.subText(x),
      }));

      this.setData({
        all,
        pendingCount: all.filter((x) => x.status === 'reserved').length,
      });
      this.applyTab();
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  subText(r) {
    if (r.status === 'reserved') return `取货码 ${groupCode(r.code)} · 点击出示`;
    if (r.status === 'redeemed') return `已于 ${timeText(r.redeemedAt)} 取货`;
    return `已取消 · ${timeText(r.cancelledAt)}（名额已释放）`;
  },

  applyTab() {
    this.setData({ list: this.data.all.filter((x) => x.status === this.data.active) });
  },

  onTabTap(e) {
    this.setData({ active: e.currentTarget.dataset.key }, () => this.applyTab());
  },

  goPickup(e) {
    wx.navigateTo({
      url: `/packageBazaar/pages/pickup-code/index?id=${e.currentTarget.dataset.id}`,
    });
  },

  goItems() {
    wx.redirectTo({ url: '/packageBazaar/pages/items/index' });
  },
});
