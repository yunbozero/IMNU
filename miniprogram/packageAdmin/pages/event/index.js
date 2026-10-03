/**
 * 管理端 · 活动与摊位。
 *
 * 这一页补的是一条**原来只能 SSH 的路**：以前建活动 / 摊位要登上服务器改 JSON、
 * 再跑 `scripts/init-event.mjs`。对「一年做一两次」本来可以忍，但组织者手上
 * 未必有 SSH —— 换届之后那条命令谁来敲？
 * 补完之后，只有「设立第一个超管」还需要命令行（那是刻意的，不能让任何人
 * 在界面上把自己设成超管）。
 *
 * 门槛和别处一样分两级（和服务端 roles.mjs 一一对应）：
 *   · 副主任管理员及以上：能建摊位（摊位是内容，和建物品同一档）
 *   · 一级管理员及以上：能建 / 开始 / 结束活动（一改就是全场的事）
 *
 * ★ 时间**不在客户端算**。用 date / time 两个 picker 拿到
 *   「2026-04-18」和「09:00」两段字符串，拼起来发给服务端，
 *   由 `server/time.mjs` 按北京时间解析。
 *   客户端 `new Date(...)` 是按**手机时区**解释的，看着对，存进库就未必 ——
 *   手机不在国内、或者系统时区被改过，就会静默差几个小时。
 *   唯一例外是下面那个**预填**的默认日期：那只是个能被改掉的初值。
 */
import * as api from '../../../services/api.js';
import * as session from '../../../services/session.js';
import { timeText } from '../../../utils/format.js';

const STATUS_TEXT = { draft: '草稿', on_sale: '在售', ended: '已结束' };

/** 状态徽章的颜色类，和 app.wxss 里的 .tag--* 对应 */
const STATUS_CLASS = {
  draft: 'tag tag--grey',
  on_sale: 'tag tag--green',
  ended: 'tag tag--grey',
};

/** 活动时间显示成「04-18 09:00 → 04-18 17:00」；没填就说没填 */
function rangeText(e) {
  if (!e.startsAt && !e.endsAt) return '未设置时间';
  const s = e.startsAt ? timeText(e.startsAt) : '待定';
  const t = e.endsAt ? timeText(e.endsAt) : '待定';
  return `${s} → ${t}`;
}

/**
 * 今天的日期，用来**预填**表单。
 *
 * ★ 这里用本机日期部分是可以的：它只是个初值，用户看得见、改得动，
 *   而且不会被当成时间戳存起来。真正要存的时间一律由服务端按北京时间解析。
 */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

Page({
  data: {
    loading: true,
    error: '',

    canManage: false,        // 副主任及以上：摊位
    canAdminister: false,    // 一级管理员及以上：活动

    active: null,
    events: [],
    stalls: [],

    // 新建活动的表单
    name: '',
    startDate: '',
    startTime: '09:00',
    endDate: '',
    endTime: '17:00',
    submitting: false,

    // 新建摊位的表单
    stallName: '',
    stallLoc: '',
    busyStall: false,
  },

  onLoad() {
    const d = today();
    this.setData({ startDate: d, endDate: d });
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

      // canManage / canAdminister 两个都算出来：摊位和活动的门槛不一样，
      // 页面上按这个显示/隐藏表单（服务端还会各判一次）
      this.setData({
        canManage: true,
        canAdminister: session.isSeniorManager(),
      });

      // 在售活动和它的摊位走公开接口，不用另开
      const pub = await api.get('/api/event', { token: session.getToken() });
      this.setData({
        active: pub.event ? { ...pub.event, rangeText: rangeText(pub.event) } : null,
        stalls: pub.stalls || [],
      });

      // 活动列表只有一级管理员能看
      if (session.isSeniorManager()) {
        const r = await api.get('/api/admin/events', { token: session.getToken() });
        this.setData({
          events: (r.events || []).map((e) => ({
            ...e,
            statusText: STATUS_TEXT[e.status] || e.status,
            statusClass: STATUS_CLASS[e.status] || 'tag',
            rangeText: rangeText(e),
            // 每种状态给一个「下一步」按钮；已结束的不给（重开没有实际用途）
            action: e.status === 'draft' ? '开始' : (e.status === 'on_sale' ? '结束' : ''),
          })),
        });
      }
    } catch (e) {
      if (e && e.code === 'need_register') return session.handleError(e);
      this.setData({ error: (e && e.message) || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /* ---------------- 新建活动 ---------------- */

  onName(e) { this.setData({ name: e.detail.value }); },
  onStartDate(e) { this.setData({ startDate: e.detail.value }); },
  onStartTime(e) { this.setData({ startTime: e.detail.value }); },
  onEndDate(e) { this.setData({ endDate: e.detail.value }); },
  onEndTime(e) { this.setData({ endTime: e.detail.value }); },

  /** 拼成服务端认的 "2026-04-18 09:00"；日期没选就是空（允许不填时间） */
  buildTime(date, time) {
    return date ? `${date} ${time}` : '';
  },

  async submitEvent(e) {
    if (this.data.submitting) return;
    const draft = e.currentTarget.dataset.draft === 'true';

    const name = String(this.data.name || '').trim();
    if (!name) return wx.showToast({ title: '请填活动名', icon: 'none' });

    const body = {
      name,
      startsAt: this.buildTime(this.data.startDate, this.data.startTime),
      endsAt: this.buildTime(this.data.endDate, this.data.endTime),
      draft,
    };

    // ★ 至多一个在售活动：已经有一个在售时先问清楚。
    //   不问就让两个并存的话，首页只显示最新的那个、管理端却看着有两个 ——
    //   排查起来很费劲，所以宁可多问一句。
    if (!draft && this.data.active) {
      const ok = await new Promise((resolve) => {
        wx.showModal({
          title: '先结束现在的活动？',
          content: `现在在售的是「${this.data.active.name}」。开始新活动会把它结束掉，`
            + '结束之后学生就看不到它了。要继续吗？',
          confirmText: '结束并开始',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!ok) return undefined;
      body.endPrevious = true;
    }

    this.setData({ submitting: true });
    try {
      await api.post('/api/admin/event', { token: session.getToken(), body });
      wx.showToast({ title: draft ? '已存为草稿' : '活动已开始', icon: 'success' });
      this.setData({ name: '' });
      await this.load();
    } catch (err) {
      session.handleError(err);
    } finally {
      this.setData({ submitting: false });
    }
    return undefined;
  },

  /** 草稿 → 开始；在售 → 结束 */
  async toggleStatus(e) {
    const { id, status, name } = e.currentTarget.dataset;
    const next = status === 'draft' ? 'on_sale' : 'ended';

    if (next === 'ended') {
      const ok = await new Promise((resolve) => {
        wx.showModal({
          title: '结束这个活动？',
          content: `「${name}」结束之后学生就看不到它了，已定的名额不受影响。确定吗？`,
          confirmText: '结束活动',
          confirmColor: '#C6432F',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!ok) return undefined;
    }

    try {
      await api.post('/api/admin/event/status', {
        token: session.getToken(),
        body: { eventId: id, status: next },
      });
      wx.showToast({ title: next === 'on_sale' ? '活动已开始' : '活动已结束', icon: 'success' });
      await this.load();
    } catch (err) {
      // 「「X」还在售，要开始这个请先把那个结束掉」这类文案服务端已经写好了
      session.handleError(err);
    }
    return undefined;
  },

  /* ---------------- 新建摊位 ---------------- */

  onStallName(e) { this.setData({ stallName: e.detail.value }); },
  onStallLoc(e) { this.setData({ stallLoc: e.detail.value }); },

  async submitStall() {
    if (this.data.busyStall) return;   // 防连点：连点两下就是两个同名摊位

    const name = String(this.data.stallName || '').trim();
    if (!name) return wx.showToast({ title: '请填摊位名', icon: 'none' });

    this.setData({ busyStall: true });
    try {
      await api.post('/api/admin/stall', {
        token: session.getToken(),
        body: { name, loc: String(this.data.stallLoc || '').trim() },
      });
      wx.showToast({ title: '摊位已加上', icon: 'success' });
      this.setData({ stallName: '', stallLoc: '' });
      await this.load();
    } catch (err) {
      session.handleError(err);
    } finally {
      this.setData({ busyStall: false });
    }
    return undefined;
  },
});
