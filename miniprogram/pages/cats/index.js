/**
 * 猫猫图鉴（tabBar 页面，所以在主包）。
 *
 * 资料来自服务端（`/api/cats`，见 services/cats.js）。先用本地缓存**同步**
 * 渲染一次，再异步拉一次刷新 —— 图鉴原来是「零请求、断网也能看」的页面，
 * 不能因为改成读接口就让首屏空一下、或者断网时整页什么都没有。
 *
 * 详情页在分包 packageCats 里。
 */
import { CAT_LIST_GROUPS, FEEDING_TIPS } from '../../data/cats.js';
import * as cats from '../../services/cats.js';

Page({
  data: {
    groups: CAT_LIST_GROUPS,
    active: 'onCampus',
    list: [],
    tips: FEEDING_TIPS,
    // 加载失败过的猫 id —— 那一格回落到 emoji
    photoFailed: {},
    // 连缓存都没有、接口也没问到 —— 给一句人话，而不是一片空白
    offline: false,
  },

  onLoad() {
    this.all = cats.cached();
    this.switchTo('onCampus');
    this.refresh();
  },

  onShow() {
    // 从详情页/管理端回来时可能已经改了资料，重新拉一次
    if (this.all) this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  /** 异步拉一次；拿不到就继续用缓存（不弹错、不显示加载态） */
  async refresh() {
    const list = await cats.fetchCats();
    if (!list) {
      // 没问到 ≠ 一只猫都没有：什么都别改，只在「也确实没有缓存」时提示一句
      if (!this.all.length) this.setData({ offline: true });
      return;
    }
    this.all = list;
    this.setData({ offline: false });
    this.switchTo(this.data.active);
  },
  switchTo(key) {
    this.setData({
      active: key,
      list: cats.byStatus(this.all, key).map(cats.decorate),
    });
  },

  /** 照片加载失败 → 这一格回落到 emoji（按 id 记，切分组会重排） */
  onPhotoError(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.photoFailed[id]) return;
    this.setData({ [`photoFailed.${id}`]: true });
  },

  onTabTap(e) {
    this.switchTo(e.currentTarget.dataset.key);
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/packageCats/pages/detail/index?id=${e.currentTarget.dataset.id}`,
    });
  },
});
