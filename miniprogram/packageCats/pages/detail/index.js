import { findCat, CAT_STATUS } from '../../../data/cats.js';
import { imageUrl } from '../../../utils/format.js';

Page({
  data: { cat: null, statusText: '', photo: '', photoFailed: false },

  onLoad(query) {
    const cat = findCat((query && query.id) || '');
    if (!cat) {
      wx.showToast({ title: '找不到这只猫', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({
      cat,
      statusText: CAT_STATUS[cat.status] || '',
      // 没有照片就是空串，模板据此回落到 emoji + 底色
      photo: imageUrl(cat),
    });
    wx.setNavigationBarTitle({ title: cat.name });
  },

  /** 照片加载失败（网络不通、文件不在）→ 回落到 emoji，别留一个空框 */
  onPhotoError() {
    if (!this.data.photoFailed) this.setData({ photoFailed: true });
  },
});
