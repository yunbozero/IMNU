import * as api from '../../../services/api.js';
import { quotaText, quotaLevel, quotaPercent, imageUrl } from '../../../utils/format.js';

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
    // 照片加载失败过的物品 id。键是 id，值恒为 true —— 模板里这样写就能回落 emoji。
    imageFailed: {},
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
        imageUrl: imageUrl(it),
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

  /**
   * 照片加载失败 → 这一格回落到 emoji。
   *
   * 按 id 记，不按下标：列表会被筛选重排，下标对不上就会标记错行。
   * 用 `imageFailed.<id>` 这种路径写法，只更新那一条，不重建整个列表。
   */
  onImageError(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.imageFailed[id]) return;
    this.setData({ [`imageFailed.${id}`]: true });
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/packageBazaar/pages/detail/index?id=${e.currentTarget.dataset.id}`,
    });
  },
});
