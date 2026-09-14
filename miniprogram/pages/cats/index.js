/**
 * 猫猫图鉴（tabBar 页面，所以在主包）。
 *
 * 数据是静态的，不发任何网络请求 —— 所以没网也能看。
 * 详情页在分包 packageCats 里。
 */
import { CAT_LIST_GROUPS, catsByStatus, FEEDING_TIPS } from '../../data/cats.js';

Page({
  data: {
    groups: CAT_LIST_GROUPS,
    active: 'onCampus',
    cats: [],
    tips: FEEDING_TIPS,
  },

  onLoad() {
    this.switchTo('onCampus');
  },

  switchTo(key) {
    this.setData({ active: key, cats: catsByStatus(key) });
  },

  onTabTap(e) {
    this.switchTo(e.currentTarget.dataset.key);
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/packageCats/pages/detail/index?id=${e.currentTarget.dataset.id}`,
    });
  },

  goAdoption() {
    wx.navigateTo({ url: '/packageCats/pages/adoption/index' });
  },
});
