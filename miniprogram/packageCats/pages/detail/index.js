/**
 * 图鉴 · 单只猫的详情。
 *
 * 资料来自服务端（见 services/cats.js）。和列表页同一套路：
 * 先用本地缓存**同步**渲染，再异步拉一次；拉不到就继续用缓存。
 * 拿不到照片、或者加载失败，都回落到 emoji + 底色，所以仍然能看资料。
 */
import * as cats from '../../../services/cats.js';

Page({
  data: { cat: null, photo: '', photoFailed: false, missing: false },

  onLoad(query) {
    this.id = (query && query.id) || '';

    // ★ 先用缓存同步渲染 —— 从列表页点进来时它一定命中，
    //   所以不会出现「先白一下再出内容」。
    this.apply(cats.cached());
    this.refresh();
  },

  async refresh() {
    const list = await cats.fetchCats();
    if (!list) return;              // 没问到 ≠ 这只猫没了
    this.apply(list);
  },

  /**
   * 按 id 从一份列表里取出这只猫。
   *
   * ★ 只有**地址真的变了**才清掉 photoFailed。地址没变却清掉的话，
   *   微信那边「这张图加载失败过」的结果是会被记住的，不会因为重新 setData
   *   就再试一次 —— 于是失败标记被清掉、错误又不再触发，那个格子就永远空着，
   *   正是 binderror 本来要防的情况。
   */
  apply(list) {
    const found = cats.findById(list, this.id);
    if (!found) {
      // 拉回来的列表里没有这只猫 —— 多半是管理员刚把它删了。
      // 缓存里有、接口没有时**以接口为准**，所以要清掉旧的 cat，
      // 否则会一直显示一只已经不存在的猫。
      if (this.data.cat) this.setData({ cat: null, photo: '', missing: true });
      return;
    }

    const cat = cats.decorate(found);
    const changed = cat.photo !== this.data.photo;

    this.setData({
      cat,
      photo: cat.photo,
      photoFailed: changed ? false : this.data.photoFailed,
      missing: false,
    });

    if (this.title !== cat.name) {
      this.title = cat.name;
      wx.setNavigationBarTitle({ title: cat.name });
    }
  },

  /** 照片加载失败（网络不通、文件不在）→ 回落到 emoji，别留一个空框 */
  onPhotoError() {
    if (!this.data.photoFailed) this.setData({ photoFailed: true });
  },
});
