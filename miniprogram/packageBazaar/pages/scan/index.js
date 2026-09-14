import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import { platform } from '../../../services/platform.js';
import { clockText } from '../../../utils/format.js';

const CODE_LEN = 6;

Page({
  data: {
    isStaff: false,
    loading: true,
    error: '',
    doneCount: 0,
    records: [],
    // 输码弹层
    showPad: false,
    buf: '',
    slots: [],
    // 核销结果
    result: null,
  },

  onLoad() {
    this.load();
  },

  onShow() {
    if (!this.data.loading) this.load();
  },

  async load() {
    this.setData({ error: '' });
    try {
      await session.ensureSession();
      if (!session.isStaff()) {
        this.setData({ error: '只有志愿者可以核销' });
        return;
      }
      // 志愿者没有单独的记录接口，这里用「我的预定」接口拿不到全量，
      // 所以今日核销数暂时只做本地累计，真正的明细在管理后台看。
      this.setData({ isStaff: true });
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /* ---------------- 扫码 ---------------- */
  async onScan() {
    let code = '';
    try {
      const res = await platform().scanCode();
      code = String(res.result || '').replace(/\D/g, '');
    } catch (e) {
      return;   // 用户自己取消了扫码，不算错误，别弹提示
    }

    if (code.length !== CODE_LEN) {
      return wx.showToast({ title: '这不是有效的取货码', icon: 'none' });
    }
    this.submit(code);
  },

  /* ---------------- 手动输码 ---------------- */
  openPad() {
    this.setData({ showPad: true, buf: '', slots: this.buildSlots('') });
  },

  closePad() {
    this.setData({ showPad: false });
  },

  noop() { /* 阻止冒泡 */ },

  buildSlots(buf) {
    const slots = [];
    for (let i = 0; i < CODE_LEN; i++) {
      slots.push({
        ch: buf[i] || '',
        cls: buf[i] ? 'slots__cell slots__cell--filled'
          : (i === buf.length ? 'slots__cell slots__cell--cursor' : 'slots__cell'),
      });
    }
    return slots;
  },

  onKey(e) {
    const k = e.currentTarget.dataset.k;
    let buf = this.data.buf;

    if (k === 'clear') buf = '';
    else if (k === 'del') buf = buf.slice(0, -1);
    else if (buf.length < CODE_LEN) buf += k;

    this.setData({ buf, slots: this.buildSlots(buf) });

    if (buf.length === CODE_LEN) {
      // 输满自动提交，志愿者不用再点确认
      setTimeout(() => {
        this.setData({ showPad: false });
        this.submit(buf);
      }, 160);
    }
  },

  /* ---------------- 核销 ---------------- */
  async submit(code) {
    try {
      const r = await api.post('/api/redeem', {
        token: session.getToken(),
        body: { code },
      });

      this.setData({
        result: {
          ok: true,
          title: '核销成功',
          sub: '请确认已收款后，把物品交给同学',
          rows: [
            ['物品', r.reservation.itemName || '—'],
            ['数量', `×${r.reservation.qty}`],
            ['核销时间', clockText(r.reservation.redeemedAt)],
          ],
        },
        doneCount: this.data.doneCount + 1,
      });
      this.autoCloseResult();
    } catch (e) {
      this.setData({
        result: {
          ok: false,
          title: this.failTitle(e),
          sub: (e && e.message) || '核销失败',
          rows: [],
        },
      });
    }
  },

  failTitle(e) {
    const map = {
      already_redeemed: '这个码已经核销过了',
      invalid_code: '取货码不存在',
      cancelled: '该预定已被取消',
      forbidden: '你没有核销权限',
      rate_limited: '操作太频繁',
    };
    return map[(e && e.code) || ''] || '核销失败';
  },

  autoCloseResult() {
    clearTimeout(this._t);
    // 成功后 3 秒自动返回，方便志愿者连续作业
    this._t = setTimeout(() => this.setData({ result: null }), 3000);
  },

  closeResult() {
    clearTimeout(this._t);
    this.setData({ result: null });
  },

  onUnload() {
    clearTimeout(this._t);
  },
});
