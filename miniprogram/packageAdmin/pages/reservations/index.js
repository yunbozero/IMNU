/**
 * 管理端 · 预定名单。
 *
 * 义卖当天最常用的一个页面：查谁定了什么、按取货码找人、看还剩多少人没来。
 *
 * 门槛：deputy（副主任管理员）及以上能看名单；**撤销核销只有 admin 及以上**，
 *      这个差别和服务端 api.mjs 里的判断必须一致（deputy 不能撤）。
 * 搜索是在本地做的 —— 服务端没有搜索参数，而且名单就几百条，
 *      本地过滤输入即出结果，比每敲一个字发一次请求好。
 */
import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import { statusText, statusClass, groupCode, timeText } from '../../../utils/format.js';

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'reserved', label: '待取货' },
  { key: 'redeemed', label: '已取货' },
];

Page({
  data: {
    tabs: TABS,
    active: 'all',
    loading: true,
    error: '',
    keyword: '',
    canUndo: false,
    all: [],
    list: [],
    stats: { total: 0, reserved: 0, redeemed: 0 },
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
      const me = await session.ensureSession();

      // 界面先挡一道。真正的权限在服务端 —— 没有权限时接口会返回 403。
      if (!session.isManager()) {
        this.setData({ error: '这个页面只有管理员能进' });
        return;
      }

      const r = await api.get('/api/admin/reservations', { token: session.getToken() });

      const all = (r.reservations || []).map((x) => ({
        id: x.id,
        code: x.code,
        codeText: groupCode(x.code),
        itemName: x.itemName || '（物品已删除）',
        // 学号现在是可选的（学生端已不再收集），所以这里必须能只显示昵称
        whoText: x.userSid ? `${x.userName} · 学号 ${x.userSid}` : (x.userName || '—'),
        status: x.status,
        statusText: statusText(x.status),
        statusClass: statusClass(x.status),
        timeText: x.status === 'redeemed'
          ? `核销于 ${timeText(x.redeemedAt)}`
          : `预定于 ${timeText(x.createdAt)}`,
      }));

      this.setData({
        all,
        stats: {
          total: all.length,
          reserved: all.filter((x) => x.status === 'reserved').length,
          redeemed: all.filter((x) => x.status === 'redeemed').length,
        },
        // 撤销核销门槛更高：deputy 可以看名单、改名额，但不能撤核销
        canUndo: me.role === 'admin' || me.role === 'owner',
      });

      this.applyFilter();
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  applyFilter() {
    const { active, keyword, all } = this.data;
    const kw = keyword.trim().toLowerCase();

    this.setData({
      list: all.filter((x) => {
        if (active !== 'all' && x.status !== active) return false;
        if (!kw) return true;
        return String(x.code).toLowerCase().includes(kw)
          || x.itemName.toLowerCase().includes(kw)
          || x.whoText.toLowerCase().includes(kw);
      }),
    });
  },

  onTabTap(e) {
    this.setData({ active: e.currentTarget.dataset.key }, () => this.applyFilter());
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value }, () => this.applyFilter());
  },

  async undoRedeem(e) {
    const id = e.currentTarget.dataset.id;
    const row = this.data.all.find((x) => x.id === id);
    if (!row) return;

    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '撤销核销？',
        content: `把 ${row.codeText} 改回「待取货」。用于扫错码或看错号的情况。`,
        confirmText: '撤销',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;

    try {
      await api.post('/api/admin/undo-redeem', {
        token: session.getToken(),
        body: { reservationId: id },
      });
      wx.showToast({ title: '已撤销', icon: 'success' });
      await this.load();
    } catch (err) {
      session.handleError(err);
    }
  },

  /**
   * 取消别人的预定（deputy 及以上就能做，和服务端同一门槛）。
   *
   * ★ 必须填原因：会写进操作日志，被取消的同学来问时要能查到是谁、为什么。
   * ★ 已核销的不能这样取消 —— 服务端会提示「先撤销核销」，这里直接把它弹出来。
   */
  async cancelOther(e) {
    const id = e.currentTarget.dataset.id;
    const row = this.data.all.find((x) => x.id === id);
    if (!row) return;

    const res = await new Promise((resolve) => {
      wx.showModal({
        title: `取消 ${row.codeText}？`,
        editable: true,
        placeholderText: '填一下原因，会记进操作日志',
        success: (r) => resolve(r),
        fail: () => resolve(null),
      });
    });
    if (!res || !res.confirm) return;

    const reason = String(res.content || '').trim();
    if (reason.length < 2 || reason.length > 60) {
      return wx.showToast({ title: '原因请填 2–60 个字', icon: 'none' });
    }

    try {
      await api.post('/api/admin/cancel', {
        token: session.getToken(),
        body: { reservationId: id, reason },
      });
      wx.showToast({ title: '已取消，名额已释放', icon: 'success' });
      await this.load();
    } catch (err) {
      session.handleError(err);
    }
  },
});
