/**
 * 管理端 · 新建物品。
 *
 * 义卖当天现场用：有人临时把东西拿来卖，管理员当场录进去。
 * 在这个界面做出来之前，往库里加物品只能登上服务器跑脚本 —— 组织者是没有 SSH 的。
 *
 * ★ 这里只**建**不负责改：建出来一律在售，想撤就回列表下架。
 *   所以「保存后学生立刻能看到」这句提醒必须写在按钮上面，不能让人事后才知道。
 *
 * ★ 校验先用本地的 buildCreateBody 过一遍（能立刻指出是哪一项不对），
 *   服务端还会再验一次 —— 界面上的限制只是体验，数据正确性始终以服务端为准。
 */
import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import {
  TINTS, EMOJI_SUGGESTIONS, NAME_MAX, DESC_MAX, QUOTA_MAX,
  stallOptions, buildCreateBody,
} from '../../utils/item-form.js';
import { pickAndUploadImage, reportImageResult } from '../../utils/image-upload.js';

Page({
  data: {
    loading: true,
    error: '',
    submitting: false,

    // 表单
    name: '',
    description: '',
    emoji: '',
    tint: TINTS[0].key,
    totalQuota: '',

    // 照片：image 是服务端生成的文件名（保存时带上），
    // imagePreview 是本地临时路径 —— 用它预览比用远端地址快，也不依赖网络
    image: null,
    imagePreview: '',

    // 选项
    tints: TINTS,
    emojis: EMOJI_SUGGESTIONS,
    stalls: [],
    stallNames: stallOptions([]),
    stallIndex: 0,

    // 输入框的 maxlength 也用服务端那份上限
    nameMax: NAME_MAX,
    descMax: DESC_MAX,
    quotaMax: QUOTA_MAX,
  },

  onLoad() {
    this.load();
  },

  async load() {
    this.setData({ error: '' });

    try {
      await session.ensureSession();

      if (!session.isManager()) {
        this.setData({ error: '这个页面只有管理员能进' });
        return;
      }

      // 摊位用公开接口拿（/api/event 本来就连摊位一起给），不用为它另开接口
      const r = await api.get('/api/event', { token: session.getToken() });
      if (!r.event) {
        this.setData({ error: '还没有在售的活动，先在服务器上跑一次 scripts/init-event.mjs' });
        return;
      }

      const stalls = r.stalls || [];
      this.setData({ stalls, stallNames: stallOptions(stalls) });
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onName(e) { this.setData({ name: e.detail.value }); },
  onDesc(e) { this.setData({ description: e.detail.value }); },
  onEmoji(e) { this.setData({ emoji: e.detail.value }); },
  onQuota(e) { this.setData({ totalQuota: e.detail.value }); },
  pickEmoji(e) { this.setData({ emoji: e.currentTarget.dataset.emoji }); },
  pickTint(e) { this.setData({ tint: e.currentTarget.dataset.key }); },
  onStall(e) { this.setData({ stallIndex: Number(e.detail.value) }); },

  /**
   * 选照片。
   *
   * ★ 选完**立刻上传**，而不是等提交时一起传。两个原因：
   *   1. 传图要一两秒，放在提交里会让人以为卡住了；
   *   2. 提前拿到文件名，提交时那个请求就还是几十字节的小请求。
   *   代价是「选了图但没保存」会在服务器上留一张没人引用的图 ——
   *   量很小，不值得为它做一套回滚。
   */
  async pickImage() {
    const up = await pickAndUploadImage({ token: session.getToken() });
    reportImageResult(up);
    if (!up.ok) return;

    this.setData({ image: up.image, imagePreview: up.previewPath });
  },

  /** 不要照片了 —— 回落到 emoji + 底色。已经传上去的那个文件就留在服务器上。 */
  removeImage() {
    this.setData({ image: null, imagePreview: '' });
  },

  async submit() {
    if (this.data.submitting) return;   // 防连点：连点两下就是两件一模一样的物品

    const built = buildCreateBody({
      name: this.data.name,
      description: this.data.description,
      emoji: this.data.emoji,
      tint: this.data.tint,
      totalQuota: this.data.totalQuota,
      stallIndex: this.data.stallIndex,
      image: this.data.image,
    }, this.data.stalls);

    if (!built.ok) {
      return wx.showToast({ title: built.error, icon: 'none' });
    }

    this.setData({ submitting: true });
    try {
      await api.post('/api/admin/item/create', {
        token: session.getToken(),
        body: built.body,
      });
      wx.showToast({ title: '已加上了', icon: 'success' });
      // 列表页的 onShow 会自己重新拉一次，所以退回去就能看到新物品
      setTimeout(() => wx.navigateBack(), 700);
    } catch (err) {
      // 「这个摊位不属于当前活动」这类文案服务端已经写好了，直接用
      session.handleError(err);
    } finally {
      this.setData({ submitting: false });
    }
  },
});
