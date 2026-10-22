/**
 * 管理端 · 加猫 / 改资料。
 *
 * 同一个页面做两件事：不带 `?id=` 就是新建，带了就是编辑。
 * 合成一个页面是因为字段完全一样 —— 分成两个页面的话，表单校验、
 * 字数上限、照片处理都要写两遍，改一处漏一处。
 *
 * ★ 只**编辑**、不负责删除：删除在列表页（那里能一眼看全再决定）。
 *
 * ★ 校验先用本地的 buildCatBody 过一遍（能立刻指出是哪一项不对），
 *   服务端还会再验一次 —— 界面上的限制只是体验，数据正确性始终以服务端为准。
 */
import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import * as cats from '../../../services/cats.js';
import {
  NAME_MAX, LOC_MAX, PERSONALITY_MAX, NOTE_MAX, EMOJI_MAX, IMAGES_MAX, EXTRA_FIELDS,
  TINTS, EMOJI_SUGGESTIONS, STATUSES, GENDERS,
  statusIndex, genderIndex, buildCatBody,
} from '../../utils/cat-form.js';
import { pickAndUploadImage, pickAndUploadImages, reportImageResult } from '../../utils/image-upload.js';
import { imageUrl } from '../../../utils/format.js';

const CAT_IMAGES_MAX = IMAGES_MAX;

Page({
  data: {
    loading: true,
    error: '',
    submitting: false,

    // 编辑时才有
    catId: '',
    isNew: true,

    // 表单
    name: '',
    emoji: '',
    tint: TINTS[0].key,
    statusIndex: 0,
    genderIndex: 2,
    location: '',
    personality: '',
    note: '',

    // 照片：image 是服务端生成的文件名（保存时带上），
    // imagePreview 是本地临时路径 —— 用它预览比用远端地址快，也不依赖网络
    image: null,
    imagePreview: '',

    // 相册：多张照片。images 是服务端文件名（保存时整体替换），
    // imageUrls 是拼好 BASE_URL 的展示地址。和主图分开 —— 主图是列表页用的那张。
    images: [],
    imageUrls: [],
    imageMax: CAT_IMAGES_MAX,

    // 补充资料（旧图鉴导进来的）。只开放这几项编辑，其余字段导入后只读
    extraFields: EXTRA_FIELDS,
    extras: {},

    // 选项
    tints: TINTS,
    emojis: EMOJI_SUGGESTIONS,
    statuses: STATUSES,
    genders: GENDERS,

    // 输入框的 maxlength 也用服务端那份上限
    nameMax: NAME_MAX,
    locMax: LOC_MAX,
    personalityMax: PERSONALITY_MAX,
    noteMax: NOTE_MAX,
    emojiMax: EMOJI_MAX,
  },

  onLoad(query) {
    this.catId = (query && query.id) || '';
    this.load();
  },

  async load() {
    this.setData({ error: '' });

    try {
      await session.ensureSession();

      if (!session.isStaff()) {
        this.setData({ error: '这个页面需要志愿者及以上' });
        return;
      }

      if (!this.catId) {
        wx.setNavigationBarTitle({ title: '新加一只猫' });
        return;
      }

      // 用公开接口拿，不用为「读一只猫」另开一个管理端接口
      const r = await api.get('/api/cats', { token: session.getToken() });
      const found = cats.findById(r.cats, this.catId);

      if (!found) {
        this.setData({ error: '这只猫已经不在了（可能刚被删掉）' });
        return;
      }

      this.setData({
        isNew: false,
        catId: found.id,
        name: found.name,
        emoji: found.emoji || '',
        tint: found.tint || TINTS[0].key,
        statusIndex: statusIndex(found.status),
        genderIndex: genderIndex(found.gender),
        location: found.location || '',
        personality: found.personality || '',
        note: found.note || '',
        image: found.image || null,
        imagePreview: found.image ? cats.decorate(found).photo : '',
        images: found.images || [],
        imageUrls: (found.images || []).map((n) => imageUrl({ image: n })),
        extras: Object.fromEntries(EXTRA_FIELDS.map((f) => [f.key, found[f.key] || ''])),
      });
      wx.setNavigationBarTitle({ title: `改「${found.name}」` });
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onName(e) { this.setData({ name: e.detail.value }); },
  onLoc(e) { this.setData({ location: e.detail.value }); },
  onPersonality(e) { this.setData({ personality: e.detail.value }); },
  onNote(e) { this.setData({ note: e.detail.value }); },
  onEmoji(e) { this.setData({ emoji: e.detail.value }); },
  pickEmoji(e) { this.setData({ emoji: e.currentTarget.dataset.emoji }); },
  pickTint(e) { this.setData({ tint: e.currentTarget.dataset.key }); },
  onStatus(e) { this.setData({ statusIndex: Number(e.detail.value) }); },
  onGender(e) { this.setData({ genderIndex: Number(e.detail.value) }); },
  onExtra(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    this.setData({ [`extras.${key}`]: e.detail.value });
  },

  /**
   * 选照片。选完**立刻上传**，而不是等提交时一起传 ——
   * 传图要一两秒，放在提交里会让人以为卡住了。
   */
  async pickImage() {
    const up = await pickAndUploadImage({ token: session.getToken() });
    reportImageResult(up);
    if (!up.ok) return;

    this.setData({ image: up.image, imagePreview: up.previewPath });
  },

  /** 不要照片了 —— 回落到 emoji + 底色 */
  removeImage() {
    this.setData({ image: null, imagePreview: '' });
  },

  /**
   * 往相册里加照片：**一次能多选**，按住顺序一张张传。
   *
   * ★ 一张失败不影响其它的 —— 返回里带失败张数，界面上说清楚。
   *   和主图一样「选完立刻上传」，保存时只提交文件名列表。
   */
  async addGalleryImage() {
    const remain = CAT_IMAGES_MAX - this.data.images.length;
    if (remain <= 0) {
      return wx.showToast({ title: `相册最多 ${CAT_IMAGES_MAX} 张`, icon: 'none' });
    }

    const up = await pickAndUploadImages({ token: session.getToken(), count: remain });
    if (!up.ok) return;   // 用户取消

    if (up.failed) {
      wx.showToast({ title: `成功 ${up.items.length} 张，失败 ${up.failed} 张`, icon: 'none' });
    }
    if (!up.items.length) return;

    this.setData({
      images: [...this.data.images, ...up.items.map((x) => x.image)],
      imageUrls: [...this.data.imageUrls, ...up.items.map((x) => x.previewPath)],
    });
  },

  /** 从相册里去掉一张。只是从这一页移走，**保存之后**才真的从库里删 */
  removeGalleryImage(e) {
    const i = Number(e.currentTarget.dataset.index);
    const images = this.data.images.filter((_, k) => k !== i);
    this.setData({ images, imageUrls: images.map((n) => imageUrl({ image: n })) });
  },

  async submit() {
    if (this.data.submitting) return;   // 防连点：连点两下就是两只一模一样的猫

    const built = buildCatBody({
      name: this.data.name,
      emoji: this.data.emoji,
      tint: this.data.tint,
      statusIndex: this.data.statusIndex,
      gender: GENDERS[this.data.genderIndex],
      location: this.data.location,
      personality: this.data.personality,
      note: this.data.note,
      image: this.data.image,
      ...this.data.extras,
    });

    if (!built.ok) {
      return wx.showToast({ title: built.error, icon: 'none' });
    }

    this.setData({ submitting: true });
    try {
      const body = this.catId ? { catId: this.catId, ...built.body } : built.body;
      // 相册整体提交（空数组 = 清空）；服务端会把移出相册的文件删掉
      body.images = this.data.images;
      await api.post(
        this.catId ? '/api/admin/cat' : '/api/admin/cat/create',
        { token: session.getToken(), body }
      );
      wx.showToast({ title: this.catId ? '已保存' : '已加上', icon: 'success' });
      // 列表页的 onShow 会自己重新拉一次，所以退回去就能看到
      // ★ 定时器要落账，否则用户提前返回时它会**再退一层**
      this._backTimer = setTimeout(() => wx.navigateBack(), 700);
    } catch (err) {
      // 服务端写好的文案直接弹出来
      session.handleError(err);
    } finally {
      this.setData({ submitting: false });
    }
  },

  onUnload() {
    clearTimeout(this._backTimer);
  },
});
