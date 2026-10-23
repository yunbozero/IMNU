/**
 * 管理端 · 角色管理（提权 / 撤销 / 转交超管）。
 *
 * 展示：**按角色分块**，每块一行两个卡片（头像 + 昵称 + 角色）；
 * 超管排最前，「我自己」单独一块跟在后面 —— 改权限时最常看的就是这两块。
 * 点卡片看详情（角色、登记时间、能改成什么）。
 *
 * ★ 界面**不做任何权限判断**。服务端在 /api/admin/users 里逐行算好了
 *   `settable`（这个人能被改成哪些角色）、`canTransferOwner`，还给了各级别人数
 *   `counts` 和上限 `limits`。这里只负责画。规则只有 roles.mjs 那一处 ——
 *   界面自己判断一遍的话，必然出现「显示了按钮但点了被拒」或者反过来。
 */
import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import { imageUrl } from '../../../utils/format.js';

/** 块的顺序：从高到低。超管永远只有一个人，放最前面最省事。 */
const ROLE_ORDER = [
  { key: 'owner', label: '超管' },
  { key: 'admin', label: '一级管理员' },
  { key: 'deputy', label: '副主任' },
  { key: 'volunteer', label: '志愿者' },
  { key: 'student', label: '学生' },
];

/** 提升到某个角色意味着什么。写清楚，别让人对着一个按钮猜。 */
const CONSEQUENCE = {
  admin: '能建/结束活动、改公告和活动口令、撤销核销，**还能再任命其他一级管理员**。',
  deputy: '能看预定名单、取消误定、改物品名额、开放或关闭预定、新建物品和摊位。',
  volunteer: '能扫码核销取货码，维护猫猫图鉴。',
  student: '会撤掉他的全部管理权限。',
};

const decorate = (u) => ({
  ...u,
  avatarUrl: u.avatar ? imageUrl({ image: u.avatar }) : '',
  initial: String(u.name || '').slice(0, 1),
});

Page({
  data: {
    loading: true,
    error: '',
    busyId: '',
    sections: [],
    meCard: null,
    detail: null,
    counts: {},
    limits: {},
    // 顶部一行汇总，例如「一级 2/3 · 副主任 3/5」
    summary: '',
    iAmOwner: false,
    // 搜索：学生那一块可能几十上百人，翻起来累
    keyword: '',
    searching: false,
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

      if (!session.isSeniorManager()) {
        this.setData({ error: '这个页面只有一级管理员及以上能进' });
        return;
      }

      this.me = session.getUser();
      const r = await api.get('/api/admin/users', { token: session.getToken() });

      const counts = r.counts || {};
      const limits = r.limits || {};
      const users = (r.users || []).map(decorate);
      const me = users.find((u) => u.isSelf) || null;

      // 超管块里本来就只有一个人；其它块里把「我」摘出去（我单独一块）
      const sections = ROLE_ORDER.map(({ key, label }) => ({
        key,
        label,
        count: counts[key] || 0,
        limit: limits[key] || 0,
        users: users.filter((u) => u.role === key && !(me && u.id === me.id && key !== 'owner')),
      })).filter((s) => s.users.length > 0 || s.count > 0);

      const parts = [];
      if (counts.admin !== undefined) parts.push(`一级 ${counts.admin}/${limits.admin || '—'}`);
      if (counts.deputy !== undefined) parts.push(`副主任 ${counts.deputy}/${limits.deputy || '—'}`);
      if (counts.volunteer !== undefined) parts.push(`志愿者 ${counts.volunteer}`);

      this.setData({
        sections,
        meCard: me && me.role !== 'owner' ? me : null,
        counts,
        limits,
        summary: parts.join(' · '),
        iAmOwner: !!(this.me && this.me.role === 'owner'),
      });

      // 原始数据留着给搜索用 —— 每次改关键词都重新拉一遍接口太浪费
      this.allSections = sections;
      if (this.data.searching) this.applyFilter();
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /* ---------------- 搜索 ---------------- */

  onSearch(e) {
    this.setData({ keyword: e.detail.value, searching: !!e.detail.value.trim() });
    this.applyFilter();
  },

  clearSearch() {
    this.setData({ keyword: '', searching: false });
    if (this.allSections) this.setData({ sections: this.allSections });
  },

  /**
   * 按昵称过滤。**跨角色搜** —— 找人不该先知道他是哪一档。
   * 搜完仍然按角色分块显示，只是每块里只剩匹配的人；空块不画。
   */
  applyFilter() {
    const kw = String(this.data.keyword || '').trim().toLowerCase();
    if (!kw || !this.allSections) return;

    this.setData({
      sections: this.allSections
        .map((s) => ({ ...s, users: s.users.filter((u) => String(u.name).toLowerCase().includes(kw)) }))
        .filter((s) => s.users.length > 0),
    });
  },

  /* ---------------- 详情 ---------------- */

  openDetail(e) {
    const id = e.currentTarget.dataset.id;
    for (const s of this.data.sections) {
      const hit = s.users.find((u) => u.id === id);
      if (hit) return this.setData({ detail: hit });
    }
    if (this.data.meCard && this.data.meCard.id === id) return this.setData({ detail: this.data.meCard });
    return undefined;
  },

  closeDetail() {
    this.setData({ detail: null });
  },

  noop() { /* 阻止弹层内部点击冒泡到遮罩 */ },

  /* ---------------- 改角色 / 转交 ---------------- */

  async changeRole(e) {
    const { id, role, name } = e.currentTarget.dataset;
    if (this.data.busyId) return false;

    const detail = this.data.detail;
    const u = detail && detail.id === id ? detail : null;
    const to = u && u.settableLabels
      ? u.settableLabels[u.settable.indexOf(role)] : role;

    const lines = [`把「${name}」改成${to}。`];
    if (CONSEQUENCE[role]) lines.push(CONSEQUENCE[role]);

    // 副主任是软上限：只提醒，不拦（现场多个摊位各要一个人是常态）
    const { counts, limits } = this.data;
    if (role === 'deputy' && limits.deputy && (counts.deputy || 0) >= limits.deputy) {
      lines.push(`已经有 ${counts.deputy} 个副主任（建议不超过 ${limits.deputy} 个），仍要继续吗？`);
    }

    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: `${name} → ${to}？`,
        content: lines.join('\n'),
        confirmText: role === 'student' ? '撤销权限' : '确认设置',
        confirmColor: role === 'student' ? '#C6432F' : '#D2694A',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!ok) return false;

    const done = await this.post('/api/admin/role', { userId: id, role },
      role === 'student' ? '已撤销权限' : `已设为${to}`);
    if (done) this.setData({ detail: null });
    return done;
  },

  /**
   * 转交超管。**不可逆，而且自己会变成一级管理员** —— 所以文案必须说清，
   * 并让他在弹窗里把目标名字再确认一次。
   */
  async transfer(e) {
    const { id, name } = e.currentTarget.dataset;
    if (this.data.busyId) return false;

    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: `把超管交给「${name}」？`,
        content: '你自己会变成一级管理员，而且这一步小程序里撤不回来。'
          + '确认对方是你信任的下一届负责人。',
        confirmText: '转交',
        confirmColor: '#C6432F',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!ok) return false;

    const done = await this.post('/api/admin/transfer-owner', { userId: id }, '已转交');
    if (done) this.setData({ detail: null });
    return done;
  },

  /** 两个写操作共用的出口：成功后整页重拉 —— 权限变了，别人的按钮也会跟着变 */
  async post(path, body, toast) {
    this.setData({ busyId: body.userId });
    try {
      await api.post(path, { token: session.getToken(), body });
      wx.showToast({ title: toast, icon: 'success' });
      await this.load();
      return true;
    } catch (err) {
      session.handleError(err);
      return false;
    } finally {
      this.setData({ busyId: '' });
    }
  },
});
