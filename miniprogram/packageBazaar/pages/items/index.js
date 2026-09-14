import * as api from '../../../services/api.js';
import { quotaText, quotaLevel, quotaPercent } from '../../../utils/format.js';

Page({
  data: {
    loading: true,
    error: '',
    event: null,
    items: [],
    filtered: [],
    stalls: [],
    activeStall: 'all',
    keyword: '',
  },

  onLoad() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ error: '' });
    try {
      const r = await api.get('/api/items');
      // 展示用的字段在客户端算好，模板里只做渲染
      const items = (r.items || []).map((it) => ({
        ...it,
        quotaText: quotaText(it),
        level: quotaLevel(it),
        percent: quotaPercent(it),
      }));
      this.setData({ items, stalls: r.stalls || [], event: r.event });
      this.applyFilter();
    } catch (e) {
      this.setData({ error: e.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  applyFilter() {
    const { items, activeStall, keyword } = this.data;
    this.setData({
      filtered: items.filter((it) => {
        if (activeStall !== 'all' && it.stallId !== activeStall) return false;
        if (keyword && it.name.indexOf(keyword) === -1) return false;
        return true;
      }),
    });
  },

  onStallTap(e) {
    this.setData({ activeStall: e.currentTarget.dataset.id }, () => this.applyFilter());
  },

  onSearch(e) {
    this.setData({ keyword: String(e.detail.value || '').trim() }, () => this.applyFilter());
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/packageBazaar/pages/detail/index?id=${e.currentTarget.dataset.id}`,
    });
  },
});
