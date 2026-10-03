/**
 * 猫猫图鉴（tabBar 页面，所以在主包）。
 *
 * 猫的**资料**是静态的，不发网络请求；但**照片**放在服务器上
 * （`assets/cats/` → 发布时同步到图片目录，nginx 直接发）。
 * 为什么不把照片塞进包里：主包有 2MB 硬上限，十几张照片就顶满了，
 * 而主包每冷启动都要下载一遍 —— 仓库自己的原则也是「主包要尽量小」。
 * 照片没加载出来就回落 emoji + 底色，所以断网时图鉴仍然能看。
 *
 * 详情页在分包 packageCats 里。
 */
import { CAT_LIST_GROUPS, catsByStatus, FEEDING_TIPS } from '../../data/cats.js';
import { imageUrl } from '../../utils/format.js';

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
    this.switchTo('onCampus');
  },

  switchTo(key) {
    // 给每只猫算好完整地址（模板里拼不了 BASE_URL）
    const cats = catsByStatus(key).map((c) => ({ ...c, photo: imageUrl(c) }));
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
