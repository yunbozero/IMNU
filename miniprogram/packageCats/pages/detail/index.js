/**
 * 图鉴 · 单只猫的详情。
 *
 * 照片和列表页同一套路（见 services/cat-photos.js）：
 * 先用本地缓存同步渲染，再异步拉一次覆盖表；拉不到就继续用缓存和仓库那张。
 * 拿不到照片、或者加载失败，都回落到 emoji + 底色，所以断网也能看资料。
 */
import { findCat, CAT_STATUS } from '../../../data/cats.js';
import * as catPhotos from '../../../services/cat-photos.js';

Page({
  data: { cat: null, statusText: '', photo: '', photoFailed: false },

  onLoad(query) {
    const cat = findCat((query && query.id) || '');
    if (!cat) {
      wx.showToast({ title: '找不到这只猫', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }

    this.cat = cat;
    this.apply(catPhotos.cached());

    wx.setNavigationBarTitle({ title: cat.name });
    this.refreshPhotos();
  },

  /**
   * 换一张照片 → 重算地址。
   *
   * ★ 只有**地址真的变了**才清掉 photoFailed。地址没变却清掉的话，
   *   微信那边「这张图加载失败过」的结果是会被记住的，不会因为重新 setData
   *   就再试一次 —— 于是失败标记被清掉、错误又不再触发，那个格子就永远空着，
   *   正是 binderror 本来要防的情况。
   */
  apply(photos) {
    const photo = catPhotos.withPhoto(this.cat, photos).photo;
    const changed = photo !== this.data.photo;

    this.setData({
      cat: this.cat,
      statusText: CAT_STATUS[this.cat.status] || '',
      // 没有照片就是空串，模板据此回落到 emoji + 底色
      photo,
      photoFailed: changed ? false : this.data.photoFailed,
    });
  },

  async refreshPhotos() {
    const photos = await catPhotos.fetch();
    if (!photos) return;              // 没问到 ≠ 没有覆盖
    this.apply(photos);
  },

  /** 照片加载失败（网络不通、文件不在）→ 回落到 emoji，别留一个空框 */
  onPhotoError() {
    if (!this.data.photoFailed) this.setData({ photoFailed: true });
  },
});
