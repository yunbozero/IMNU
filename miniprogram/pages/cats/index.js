/**
 * 猫猫图鉴（tabBar 页面，所以在主包）。
 *
 * 猫的**资料**是静态的，不发网络请求；**照片**有两个来源：
 *   · 仓库里的 `assets/cats/xxx.jpg`（兜底，跟着发布同步到服务器）
 *   · 管理员在小程序里换的那张（存在数据库，见 services/cat-photos.js）
 * 合并规则只有一条：有覆盖用覆盖，没有就用仓库那张。没有照片、或者照片加载
 * 失败，一律回落 emoji + 底色 —— 所以**断网也能看图鉴**。
 *
 * 为什么不把照片塞进包里：主包有 2MB 硬上限，十几张照片就顶满了，
 * 而主包每冷启动都要下载一遍 —— 仓库自己的原则也是「主包要尽量小」。
 *
 * 详情页在分包 packageCats 里。
 */
import { CAT_LIST_GROUPS, catsByStatus, FEEDING_TIPS } from '../../data/cats.js';
import * as catPhotos from '../../services/cat-photos.js';

Page({
  data: {
    groups: CAT_LIST_GROUPS,
    active: 'onCampus',
    cats: [],
    tips: FEEDING_TIPS,
    // 加载失败过的猫 id —— 那一格回落到 emoji
    photoFailed: {},
  },

  onLoad() {
    // ★ 先用缓存同步渲染一次：图鉴原本是「零请求、断网也能看」的页面，
    //   不能因为多了个覆盖表就让它首屏空一下。
    this.photos = catPhotos.cached();
    this.switchTo('onCampus');
    this.refreshPhotos();
  },

  /** 再异步拉一次覆盖表；拿不到就继续用缓存和仓库那张（不弹错、不显示加载态） */
  async refreshPhotos() {
    const photos = await catPhotos.fetch();
    if (!photos) return;              // 没问到 ≠ 没有覆盖，什么都别动
    this.photos = photos;
    this.switchTo(this.data.active);
  },

  switchTo(key) {
    // 给每只猫算好完整地址（模板里拼不了 BASE_URL）
    const cats = catsByStatus(key).map((c) => catPhotos.withPhoto(c, this.photos));
    this.setData({ active: key, cats });
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

