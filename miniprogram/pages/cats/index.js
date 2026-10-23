/**
 * 猫猫图鉴（tabBar 页面，所以在主包）。
 *
 * 资料来自服务端（`/api/cats`，见 services/cats.js）。先用本地缓存**同步**
 * 渲染一次，再异步拉一次刷新 —— 图鉴原来是「零请求、断网也能看」的页面，
 * 不能因为改成读接口就让首屏空一下、或者断网时整页什么都没有。
 *
 * 详情页在分包 packageCats 里。
 */
import { CAT_LIST_GROUPS } from '../../data/cats.js';
import * as cats from '../../services/cats.js';
import * as copy from '../../services/copy.js';

Page({
  data: {
    groups: CAT_LIST_GROUPS,
    active: 'onCampus',
    list: [],
    // 喂养提示：先用本地默认值同步渲染，随后被服务端下发的版本覆盖（管理员可改，不用发版）
    tips: copy.DEFAULTS.catTips.items,
    tipsTitle: copy.DEFAULTS.catTips.title,
    // 搜索：有词时**跨分组**搜，不受当前 tab 限制
    keyword: '',
    searching: false,
    // 加载失败过的猫 id —— 那一格回落到 emoji
    photoFailed: {},
    // 连缓存都没有、接口也没问到 —— 给一句人话，而不是一片空白
    offline: false,
  },

  onLoad() {
    this.all = cats.cached();
    this.switchTo('onCampus');
    this.refresh();
    this.loadCopy();
  },

  /** 文案：缓存/默认值先顶上，再拉一次服务端的（改文案不用发版） */
  async loadCopy() {
    const c = copy.current();
    this.setData({ tips: copy.catTips(c).items, tipsTitle: copy.catTips(c).title });
    const fresh = await copy.refresh();
    this.setData({ tips: copy.catTips(fresh).items, tipsTitle: copy.catTips(fresh).title });
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
    // 正在搜索时刷新，要接着按关键词过滤 —— 不能悄悄退出搜索
    if (this.data.searching) this.applySearch();
    else this.switchTo(this.data.active);
  },
  switchTo(key) {
    // 切分组就等于退出搜索 —— 否则「点失踪却还在看搜索结果」会很困惑
    this.setData({
      active: key,
      keyword: '',
      searching: false,
      list: cats.byStatus(this.all, key).map(cats.decorate),
    });
  },

  onSearch(e) {
    const keyword = e.detail.value;
    this.setData({ keyword, searching: !!keyword.trim() });
    this.applySearch();
  },

  clearSearch() {
    this.setData({ keyword: '', searching: false });
    this.switchTo(this.data.active);
  },

  applySearch() {
    if (!this.data.searching) return;
    this.setData({ list: cats.search(this.all, this.data.keyword).map(cats.decorate) });
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
