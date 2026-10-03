/**
 * 管理端 · 物品名额。
 *
 * 义卖当天现场用：某样东西比预期多/少，临时加减名额；卖完了就下架。
 *
 * ★ 加减的是「这个物品总共有多少份」—— 服务端把 total_quota 和 remaining_quota
 *   一起调同样的量，不是「少放一个给别人」。
 *   两种越界服务端会挡住，且文案已经写好了，直接弹给用户即可：
 *     · 总数不能低于已被预定的份数
 *     · 剩余名额不能为负
 *
 * ★ 请求进行中按钮会禁用 —— 连点两下就是 +2，名额会算多。
 *   管理端没有限流，所以这个防护只能靠界面做。
 */
import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import { quotaText, quotaLevel, quotaPercent } from '../../../utils/format.js';

const STATUS_TEXT = { on_sale: '在售', off_shelf: '已下架' };

/** 补上展示用字段。列表加载和单行更新都走它，避免两处算得不一样。 */
function decorate(it) {
  return {
    ...it,
    statusText: STATUS_TEXT[it.status] || it.status,
    offShelf: it.status === 'off_shelf',
    quotaText: quotaText(it),
    level: quotaLevel(it),
    percent: quotaPercent(it),
  };
}

Page({
  data: {
    loading: true,
    error: '',
    busyId: '',
    list: [],
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

      // 公开接口就把全部物品给了（含已下架），所以管理端不用另开接口
      const r = await api.get('/api/items', { token: session.getToken() });
      this.setData({ list: (r.items || []).map(decorate) });
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  bumpQuota(e) {
    const { id, delta } = e.currentTarget.dataset;
    return this.patch(id, { quotaDelta: Number(delta) });
  },

  /** 去新建物品页。建完它自己会退回来，本页 onShow 会重新拉一次。 */
  goNew() {
    wx.navigateTo({ url: '/packageAdmin/pages/item-new/index' });
  },

  toggleShelf(e) {
    const { id, status } = e.currentTarget.dataset;
    return this.patch(id, { status });
  },

  /** 要加一大批时不用点十几次 */
  async customQuota(e) {
    const id = e.currentTarget.dataset.id;
    const row = this.data.list.find((x) => x.id === id);
    if (!row) return;

    const res = await new Promise((resolve) => {
      wx.showModal({
        title: `${row.name} · 调整名额`,
        editable: true,
        placeholderText: '填 5 表示加 5 份，-3 表示减 3 份',
        success: (r) => resolve(r),
        fail: () => resolve(null),
      });
    });
    if (!res || !res.confirm) return;

    const delta = Number(String(res.content || '').trim());
    if (!Number.isInteger(delta) || delta === 0) {
      return wx.showToast({ title: '请输入非零整数', icon: 'none' });
    }
    return this.patch(id, { quotaDelta: delta });
  },

  async patch(itemId, body) {
    if (this.data.busyId) return;      // 防连点：连点两下名额就多加一次

    this.setData({ busyId: itemId });
    try {
      const r = await api.post('/api/admin/item', {
        token: session.getToken(),
        body: { itemId, ...body },
      });

      // 只用服务端返回的那一行替换，不整页重刷 —— 否则会丢滚动位置
      this.setData({
        list: this.data.list.map((x) => (x.id === itemId ? decorate({ ...x, ...r.item }) : x)),
      });
    } catch (err) {
      session.handleError(err);
    } finally {
      this.setData({ busyId: '' });
    }
  },
});
