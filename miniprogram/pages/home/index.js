import * as api from '../../services/api.js';
import * as session from '../../services/session.js';
import { clockText } from '../../utils/format.js';

const app = getApp();

Page({
  data: {
    loading: true,
    error: '',
    event: null,
    eventText: '活动信息加载中…',
    bazaarDesc: '看看有什么',
    isStaff: false,
    hasUser: false,
    // 首页公告：mode 1 强制（点「知道了」才关）、mode 2 五秒后自动关
    announcement: null,
    announceVisible: false,
  },

  onLoad() {
    this.load();
    this.loadAnnouncement();
  },

  /**
   * 拉公告。失败了就什么都不显示 —— 公告是锦上添花，
   * 不能因为它让首页报错，更不能挡住「看一眼有什么」这件事。
   */
  async loadAnnouncement() {
    try {
      const r = await api.get('/api/announcement');
      const a = r && r.announcement;
      if (!a || !a.mode) return;
      this.setData({ announcement: a, announceVisible: true });
      // mode 2：五秒后自动收起来（不挡操作）；定时器落账，页面走了要清
      if (a.mode === 2) {
        clearTimeout(this._announceTimer);
        this._announceTimer = setTimeout(() => this.setData({ announceVisible: false }), 5000);
      }
    } catch {
      // 静默：公告读不到不该影响首页
    }
  },

  closeAnnouncement() {
    clearTimeout(this._announceTimer);
    this.setData({ announceVisible: false });
  },

  onUnload() {
    clearTimeout(this._announceTimer);
  },

  onShow() {
    // 从别的页面回来时刷新一下身份状态（比如刚登记完）
    this.setData({
      isStaff: session.isStaff(),
      hasUser: !!session.getUser(),
    });
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      // 直接拉物品列表：顺带拿到活动信息，而且能算出「还剩几件」
      const r = await api.get('/api/items');
      const items = r.items || [];
      const left = items.reduce((n, it) => n + (it.remainingQuota || 0), 0);
      const soldOut = items.filter((it) => it.remainingQuota <= 0).length;

      this.setData({
        event: r.event,
        eventText: this.formatEvent(r.event),
        bazaarDesc: items.length
          ? `${items.length} 件物品 · 还剩 ${left} 个名额${soldOut ? ` · ${soldOut} 件已约满` : ''}`
          : '活动还没开始',
        isStaff: session.isStaff(),
        hasUser: !!session.getUser(),
      });

      app.globalData.event = r.event;
      app.globalData.eventLoaded = true;
    } catch (e) {
      this.setData({ error: e.message || '加载失败', bazaarDesc: '点这里重试' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 活动时间只有后端给了才显示，没给就写「待定」而不是编一个 */
  formatEvent(event) {
    if (!event) return '活动还没开始';

    const parts = [];
    if (event.startsAt) {
      parts.push(clockText(event.startsAt));
      if (event.endsAt) parts.push(clockText(event.endsAt));
    }
    const time = parts.length === 2 ? `${parts[0]} – ${parts[1]}` : '时间待定';
    return `${event.name} · ${time}`;
  },

  goItems() {
    wx.navigateTo({ url: '/packageBazaar/pages/items/index' });
  },

  goMyReservations() {
    wx.navigateTo({ url: '/packageBazaar/pages/my-reservations/index' });
  },

  goScan() {
    wx.navigateTo({ url: '/packageBazaar/pages/scan/index' });
  },

  goCats() {
    wx.switchTab({ url: '/pages/cats/index' });
  },

  goProfile() {
    wx.switchTab({ url: '/pages/profile/index' });
  },
});
