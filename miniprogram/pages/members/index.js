/**
 * 本届负责人（只读名单）。
 *
 * 为什么要有：义卖当天「找谁」是个真问题 —— 东西不对、码扫不出来、名额被取消了，
 * 学生不知道该找哪位志愿者或管理员。
 *
 * 边界（这三条决定了它和「角色管理」是两回事）：
 *   · 只列**负责人**（超管 / 一级管理员 / 副主任 / 志愿者），不列普通学生
 *   · 只给**已登记**用户看
 *   · 只显示头像 + 昵称 + 角色，**没有详情、没有任何操作**
 */
import * as api from '../../services/api.js';
import * as session from '../../services/session.js';
import { imageUrl } from '../../utils/format.js';

const ORDER = [
  { key: 'owner', label: '超管' },
  { key: 'admin', label: '一级管理员' },
  { key: 'deputy', label: '副主任' },
  { key: 'volunteer', label: '志愿者' },
];

Page({
  data: {
    loading: true,
    error: '',
    empty: false,
    sections: [],
    // 提示：没有负责人时给一句人话，而不是空白
    tip: '没有找到负责人。可能还没人开通权限，或者活动还没开始。',
  },

  onLoad() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ error: '' });
    try {
      await session.ensureSession();
      const r = await api.get('/api/members', { token: session.getToken() });
      const all = (r.members || []).map((m) => ({
        ...m,
        avatarUrl: m.avatar ? imageUrl({ image: m.avatar }) : '',
        initial: String(m.name || '').slice(0, 1),
      }));

      // 按角色分块。空块不画 —— 没人当副主任时，「副主任」那一栏只会占地方。
      const sections = ORDER
        .map((o) => ({ ...o, users: all.filter((m) => m.role === o.key) }))
        .filter((s) => s.users.length > 0);

      this.setData({ sections, empty: all.length === 0 });
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
    return undefined;
  },
});
