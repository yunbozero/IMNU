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
    // 每账号上限（运行期设置）。只有一级管理员及以上能看能改。
    canEditSettings: false,
    maxItemsPerUser: 0,
    maxText: '',
    maxOverridden: false,
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

      // 撤销核销和改设置都是「一级管理员及以上」：deputy 能看名单、改物品名额，
      // 但这两件事影响面更大，门槛高一级。
      // ★ 判定收在 session.js 里（和服务端 roles.mjs 的 canAdminister 比对），
      //   别在这里手写角色名 —— 改规则时手写的那份不会跟着动。
      const isSenior = session.isSeniorManager();

      this.setData({
        all,
        stats: {
          total: all.length,
          reserved: all.filter((x) => x.status === 'reserved').length,
          redeemed: all.filter((x) => x.status === 'redeemed').length,
        },
        canUndo: isSenior,
        canEditSettings: isSenior,
      });

      this.applyFilter();

      // 设置单独拉一次，而且失败不影响名单 ——
      // 名单是当天的命根子，不能因为一个设置读不到就整页打不开。
      if (isSenior) await this.loadSettings();
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadSettings() {
    try {
      const s = await api.get('/api/admin/settings', { token: session.getToken() });
      this.setData({
        maxItemsPerUser: s.maxItemsPerUser,
        maxText: s.maxItemsPerUser === 0 ? '不限' : `${s.maxItemsPerUser} 件`,
        maxOverridden: !!s.overridden,
      });
    } catch {
      // 读不到就显示成「—」，不打扰管理员
      this.setData({ maxText: '—', maxOverridden: false });
    }
  },

  /** 改「每账号最多预定几件」。改完下一笔预定就生效，不用重启服务。 */
  async editMax() {
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '每账号最多预定几件',
        editable: true,
        placeholderText: `当前 ${this.data.maxText}，填 0 表示不限`,
        success: (r) => resolve(r),
        fail: () => resolve(null),
      });
    });
    if (!res || !res.confirm) return;

    const n = Number(String(res.content || '').trim());
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      return wx.showToast({ title: '请填 0–100 的整数', icon: 'none' });
    }
    return this.saveMax(n);
  },

  /** 恢复默认（删掉设置行，回落到服务端配置的值） */
  async resetMax() {
    const okRes = await new Promise((resolve) => {
      wx.showModal({
        title: '恢复默认？',
        content: '会删掉这次手动设的上限，回落到服务端配置的默认值。',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!okRes) return;
    return this.saveMax(null);
  },

  async saveMax(value) {
    try {
      const r = await api.post('/api/admin/settings', {
        token: session.getToken(),
        body: { maxItemsPerUser: value },
      });
      this.setData({
        maxItemsPerUser: r.maxItemsPerUser,
        maxText: r.maxItemsPerUser === 0 ? '不限' : `${r.maxItemsPerUser} 件`,
        maxOverridden: !!r.overridden,
      });
      wx.showToast({ title: '已生效', icon: 'success' });
    } catch (err) {
      session.handleError(err);
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
   * 取消别人的预定 → 跳到确认页。
   *
   * 取消是不可逆的（名额立刻释放、东西归别人），所以不在列表上一步做完：
   * 确认页会把取货码、物品、取货人摊开，再让管理员选原因。
   */
  cancelOther(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/packageAdmin/pages/cancel/index?id=${id}` });
  },
});
