import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import { platform } from '../../../services/platform.js';
import { groupCode, statusText } from '../../../utils/format.js';

Page({
  data: {
    loading: true,
    error: '',
    reservation: null,
    codeText: '',
    statusText: '',
    statusClass: 'statusbar-card statusbar-card--wait',
    canCancel: false,
    fresh: false,
  },

  onLoad(query) {
    this.setData({
      id: (query && query.id) || '',
      fresh: !!(query && query.fresh === '1'),
    });
    // 进页面把屏幕调到最亮，方便志愿者扫码。离开时恢复。
    session.getUser();
    this.brighten();
    this.load();
  },

  onUnload() {
    // 恢复成跟随系统亮度
    platform().setScreenBrightness(0);
  },

  brighten() {
    platform().setScreenBrightness(1);
  },

  async load() {
    this.setData({ error: '' });
    try {
      // 先确保登录，否则拿不到自己的预定
      await session.ensureSession();
      const r = await api.get('/api/reservations', { token: session.getToken() });
      const list = r.reservations || [];
      const reservation = this.data.id
        ? list.find((x) => x.id === this.data.id)
        : list.find((x) => x.status === 'reserved');

      if (!reservation) {
        this.setData({ error: '找不到这条预定' });
        return;
      }

      this.setData({
        reservation,
        codeText: groupCode(reservation.code),
        statusText: statusText(reservation.status),
        statusClass: {
          reserved: 'statusbar-card statusbar-card--wait',
          redeemed: 'statusbar-card statusbar-card--ok',
          cancelled: 'statusbar-card statusbar-card--off',
        }[reservation.status] || 'statusbar-card',
        canCancel: reservation.status === 'reserved',
      });
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  copyCode() {
    wx.setClipboardData({
      data: String(this.data.reservation.code),
      success: () => wx.showToast({ title: '取货码已复制', icon: 'none' }),
    });
  },

  onCancel() {
    wx.showModal({
      title: '取消预定',
      content: '取消后名额会立即释放给其他同学，确定吗？',
      confirmColor: '#C6432F',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await api.post('/api/cancel', {
            token: session.getToken(),
            body: { reservationId: this.data.reservation.id },
          });
          wx.showToast({ title: '已取消，名额已释放', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 800);
        } catch (e) {
          wx.showToast({ title: (e && e.message) || '取消失败', icon: 'none' });
        }
      },
    });
  },
});
