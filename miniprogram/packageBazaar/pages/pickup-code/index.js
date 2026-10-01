import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import { platform } from '../../../services/platform.js';
import { groupCode, statusText } from '../../../utils/format.js';
import { buildQr, drawQr } from '../../utils/qr-draw.js';

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

      this.renderQr();
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 把取货码画成二维码，给核销台扫。
   *
   * 拿 canvas 节点是异步的，而且这一步失败**不能影响取货** ——
   * 画不出来就退化成「报 6 位数字」，那条路一直是通的。
   * 所以整段包在 try/catch 里，失败就静默放弃。
   */
  renderQr() {
    wx.createSelectorQuery()
      .in(this)
      .select('#qr')
      .fields({ node: true, size: true })
      .exec((res) => {
        const node = res && res[0] && res[0].node;
        if (!node) return;

        try {
          const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
          const dpr = info.pixelRatio || 2;
          const cssSize = Math.floor(res[0].width) || 220;

          // 按设备像素比放大再缩放，否则在高分屏上会是糊的
          node.width = cssSize * dpr;
          node.height = cssSize * dpr;

          const ctx = node.getContext('2d');
          ctx.scale(dpr, dpr);
          drawQr(ctx, buildQr(this.data.reservation.code), { size: cssSize });
        } catch (e) {
          // 静默放弃：数字取货码仍然可用
        }
      });
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
