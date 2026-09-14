/**
 * 小程序入口。
 */
import * as api from './services/api.js';
import * as session from './services/session.js';

App({
  globalData: {
    event: null,
    stalls: [],
    eventLoaded: false,
    user: null,
  },

  onLaunch() {
    // 静默登录。失败也不打断 —— 浏览活动信息和物品本来就不需要登录，
    // 真正需要身份的页面会自己去 ensureSession()。
    session.ensureSession()
      .then((user) => { this.globalData.user = user; })
      .catch(() => { /* 没登记或网络不通，都不该挡住首屏 */ });
  },

  /**
   * 活动信息几乎每个页面都要用，缓存在这里，避免重复请求。
   * force = true 时强制重新拉。
   */
  async loadEvent(force = false) {
    if (this.globalData.eventLoaded && !force) return this.globalData;

    const r = await api.get('/api/event');
    this.globalData.event = r.event;
    this.globalData.stalls = r.stalls || [];
    this.globalData.eventLoaded = true;
    return this.globalData;
  },
});
