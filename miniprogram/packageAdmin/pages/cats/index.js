/**
 * 管理端 · 图鉴管理。
 *
 * 图鉴原来编译在小程序包里，加一只猫、改一句性格都要发版审核（1–2 天）。
 * 现在资料在服务端（`/api/cats` 读、`/api/admin/cat*` 写），所以这一页能做全套：
 * 新建、改资料、换照片、删掉。
 *
 * ★ 门槛是**副主任及以上**（服务端也是这么卡的，界面这道只是不让人白点）。
 */
import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import * as cats from '../../../services/cats.js';
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
    // 从编辑页回来时资料可能变了，重新拉一次
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

      const r = await api.get('/api/cats', { token: session.getToken() });
      this.setData({ list: (r.cats || []).map(cats.decorate) });
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 照片加载失败 → 这一格回落到 emoji */
  onImageError(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.imageFailed[id]) return;
    this.setData({ [`imageFailed.${id}`]: true });
  },

  goNew() {
    wx.navigateTo({ url: '/packageAdmin/pages/cat-edit/index' });
  },

  goEdit(e) {
    wx.navigateTo({ url: `/packageAdmin/pages/cat-edit/index?id=${e.currentTarget.dataset.id}` });
  },

  /**
   * 换照片。已经有的先问一句是要换还是不要了 ——
   * 否则「换照片」没法表达「这张不要了，回落到 emoji」。
   */
  async changePhoto(e) {
    const id = e.currentTarget.dataset.id;
    const row = this.data.list.find((x) => x.id === id);
    if (!row || this.data.busyId) return undefined;

    if (row.photo) {
      const pick = await new Promise((resolve) => {
        wx.showActionSheet({
          itemList: ['换一张', '不要照片了'],
          success: (r) => resolve(r.tapIndex),
          fail: () => resolve(-1),
        });
      });
      if (pick === 1) return this.setPhoto(id, null);
      if (pick !== 0) return undefined;
    }

    const up = await pickAndUploadImage({ token: session.getToken() });
    reportImageResult(up);
    if (!up.ok) return undefined;

    return this.setPhoto(id, up.image);
  },

  async setPhoto(catId, image) {
    if (this.data.busyId) return false;

    this.setData({ busyId: catId });
    try {
      // 服务端是「传什么改什么」，所以这里只传 image —— 只改照片不会把别的字段清空
      const r = await api.post('/api/admin/cat', {
        token: session.getToken(),
        body: { catId, image },
      });

      this.setData({
        list: this.data.list.map((x) => (x.id === catId ? cats.decorate(r.cat) : x)),
        // 地址变了要让它重新试一次加载
        imageFailed: { ...this.data.imageFailed, [catId]: false },
      });
      wx.showToast({ title: image ? '已更新' : '已去掉照片', icon: 'success' });
      return true;
    } catch (err) {
      session.handleError(err);
      return false;
    } finally {
      this.setData({ busyId: '' });
    }
  },

  /**
   * 删掉一只猫。**真删，小程序里没有恢复** —— 所以文案要写清后果，
   * 并提醒「如果只是不在了，应该改成失踪/离世」。
   */
  async removeCat(e) {
    const id = e.currentTarget.dataset.id;
    const row = this.data.list.find((x) => x.id === id);
    if (!row || this.data.busyId) return undefined;

    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: `删除「${row.name}」？`,
        content: '删除后图鉴里就没有它了，小程序里没有「恢复」。'
          + '如果它只是不见了或者已经离世，应该改成对应状态、留在图鉴里。',
        confirmText: '删除',
        confirmColor: '#C6432F',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!ok) return undefined;

    this.setData({ busyId: id });
    try {
      await api.post('/api/admin/cat/delete', {
        token: session.getToken(),
        body: { catId: id },
      });
      this.setData({ list: this.data.list.filter((x) => x.id !== id) });
      wx.showToast({ title: '已删除', icon: 'success' });
    } catch (err) {
      session.handleError(err);
    } finally {
      this.setData({ busyId: '' });
    }
    return undefined;
  },
});
