import { findCat, CAT_STATUS } from '../../../data/cats.js';

Page({
  data: { cat: null, statusText: '' },

  onLoad(query) {
    const cat = findCat((query && query.id) || '');
    if (!cat) {
      wx.showToast({ title: '找不到这只猫', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({ cat, statusText: CAT_STATUS[cat.status] || '' });
    wx.setNavigationBarTitle({ title: cat.name });
  },
});
