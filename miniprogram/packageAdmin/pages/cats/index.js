/**
 * 管理端 · 图鉴照片。
 *
 * 猫的**资料**编译在小程序包里（miniprogram/data/cats.js），改一次要发一次版；
 * 但**照片**可以在这一页直接换 —— 拍到了新照片想马上用，不用等审核。
 *
 * 每一行两个来源，优先级只有一条：
 *   · 显示覆盖图（数据库里的，管理员传的）→ 「恢复默认」把它删掉；
 *   · 没有覆盖就显示仓库里那张（assets/cats/xxx.jpg）→ 按钮是「配图」。
 *
 * ★ 为什么「恢复默认」不是「删除照片」：仓库那张是兜底，删掉覆盖只是回到它。
 *   新库、新服务器上线时图鉴首屏就有图，靠的就是它。
 */
import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import { CATS } from '../../../data/cats.js';
import * as catPhotos from '../../../services/cat-photos.js';
import { pickAndUploadImage, reportImageResult } from '../../utils/image-upload.js';

Page({
  data: {
    loading: true,
    error: '',
    busyId: '',
    list: [],
    imageFailed: {},
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ error: '' });

    try {
      await session.ensureSession();

      if (!session.isManager()) {
        this.setData({ error: '这个页面只有管理员能进' });
        return;
      }

      // ★ 覆盖表走的是**公开接口**（图鉴页所有人都在读它），管理端不用另开一个。
      //   这里不复用 catPhotos.fetch()，因为它失败时返回 null 且会写缓存 ——
      //   管理端要能把失败**说出来**，而不是安静地显示仓库那张。
      const r = await api.get('/api/cat-photos', { token: session.getToken() });
      this.apply(r && r.photos);
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 按「仓库照片 + 覆盖」拼出列表。
   *
   * ★ 列表加载和单行更新**都走它** —— 两处各算一遍的话，迟早会出现
   *   「换完图这一行显示的来源和刚进来时不一样」这种自己跟自己对不上的状态。
   */
  apply(photos) {
    this.photos = photos && typeof photos === 'object' ? photos : {};

    this.setData({
      list: CATS.map((cat) => ({
        ...cat,
        overridden: !!this.photos[cat.id],
        imageUrl: catPhotos.withPhoto(cat, this.photos).photo,
        source: this.photos[cat.id]
          ? '小程序里换的'
          : (cat.image ? '仓库里的默认照片' : '还没有照片'),
      })),
    });
  },

  /** 照片加载失败 → 这一格回落到 emoji */
  onImageError(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.imageFailed[id]) return;
    this.setData({ [`imageFailed.${id}`]: true });
  },

  /**
   * 换图 / 配图 / 恢复默认。
   *
   * 已经有照片的，先问一句是要换还是恢复 —— 否则「换图」没法表达「不要这张了」。
   */
  async changePhoto(e) {
    const id = e.currentTarget.dataset.id;
    const row = this.data.list.find((x) => x.id === id);
    if (!row || this.data.busyId) return undefined;

    if (row.overridden) {
      const pick = await new Promise((resolve) => {
        wx.showActionSheet({
          itemList: ['换一张', '恢复默认'],
          success: (r) => resolve(r.tapIndex),
          fail: () => resolve(-1),
        });
      });
      if (pick === 1) return this.setPhoto(id, null, '已恢复默认');
      if (pick !== 0) return undefined;
    }

    const up = await pickAndUploadImage({ token: session.getToken() });
    reportImageResult(up);
    if (!up.ok) return undefined;

    return this.setPhoto(id, up.image, '已更新');
  },

  /** 写覆盖，然后按服务端返回的结果重算列表 */
  async setPhoto(catId, image, toast) {
    if (this.data.busyId) return false;

    this.setData({ busyId: catId });
    try {
      // 服务端返回的 image 是权威值：传 null 恢复默认时它就是 null
      const r = await api.post('/api/admin/cat-photo', {
        token: session.getToken(),
        body: { catId, image },
      });

      const next = { ...this.photos };
      if (r && r.image) next[catId] = r.image;
      else delete next[catId];

      // 地址变了就让它重新试一次加载（旧地址的失败记录不该跟着新图走）
      const failed = { ...this.data.imageFailed };
      delete failed[catId];
      this.setData({ imageFailed: failed });

      this.apply(next);
      wx.showToast({ title: toast, icon: 'success' });
      return true;
    } catch (err) {
      session.handleError(err);
      return false;
    } finally {
      this.setData({ busyId: '' });
    }
  },
});
