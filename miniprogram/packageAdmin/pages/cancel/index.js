/**
 * 管理端 · 取消别人的预定（确认页）。
 *
 * 为什么单独一个页面而不是弹个框：取消是**破坏性操作**（名额直接释放、东西归别人），
 * 所以先把这一笔的取货码、物品、取货人摊开给管理员看清楚，再选原因。
 * 只有「待取货」的能取消 —— 已取货的先回名单里撤销核销。
 *
 * 数据从 /api/admin/reservations 取（按 id 找那一条），不靠页面之间传参：
 * 传参会被改，而且拿不到最新状态。
 */
import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import { groupCode, statusText, timeText } from '../../../utils/format.js';
import { REASONS, OTHER_KEY, OTHER_LABEL, composeReason } from '../../utils/cancel-reason.js';

Page({
  data: {
    loading: true,
    error: '',
    id: '',
    row: null,
    canCancel: false,
    // 原因
    reasons: [...REASONS, { key: OTHER_KEY, label: OTHER_LABEL }],
    otherKey: OTHER_KEY,
    picked: '',
    otherText: '',
    submitting: false,
  },

  onLoad(query) {
    this.setData({ id: (query && query.id) || '' });
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
      if (!this.data.id) {
        this.setData({ error: '没带上要取消哪一笔' });
        return;
      }

      const r = await api.get('/api/admin/reservations', { token: session.getToken() });
      const x = (r.reservations || []).find((it) => it.id === this.data.id);
      if (!x) {
        this.setData({ error: '找不到这条预定，可能刚被处理过' });
        return;
      }

      this.setData({
        row: {
          id: x.id,
          codeText: groupCode(x.code),
          itemName: x.itemName || '（物品已删除）',
          whoText: x.userSid ? `${x.userName} · 学号 ${x.userSid}` : (x.userName || '—'),
          statusText: statusText(x.status),
          timeText: x.status === 'redeemed'
            ? `核销于 ${timeText(x.redeemedAt)}`
            : `预定于 ${timeText(x.createdAt)}`,
        },
        // 只有待取货的能取消。已取货的要先撤销核销，已取消的没什么可做。
        canCancel: x.status === 'reserved',
      });
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  pickReason(e) {
    const key = e.currentTarget.dataset.key;
    // 从「其他」切走时把已填的文字留着（切回来还在），不清空 —— 手打的内容不该被误删
    this.setData({ picked: key });
  },

  onOtherInput(e) {
    this.setData({ otherText: e.detail.value });
  },

  async submit() {
    if (this.data.submitting) return;   // 防连点：取消是不可逆的

    const verdict = composeReason(this.data.picked, this.data.otherText);
    if (!verdict.ok) {
      return wx.showToast({ title: verdict.message, icon: 'none' });
    }

    const row = this.data.row;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '确认取消？',
        content: `取消 ${row.codeText} 后名额立即释放给其他同学，且不能撤销。`,
        confirmText: '确认取消',
        confirmColor: '#C6432F',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;

    this.setData({ submitting: true });
    try {
      await api.post('/api/admin/cancel', {
        token: session.getToken(),
        body: { reservationId: this.data.id, reason: verdict.reason },
      });
      wx.showToast({ title: '已取消，名额已释放', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (err) {
      // 「已经核销过了，要取消请先撤销核销」这类文案服务端已经写好了
      session.handleError(err);
    } finally {
      this.setData({ submitting: false });
    }
  },
});
