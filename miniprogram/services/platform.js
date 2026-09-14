/**
 * 把微信的能力收在一个地方。
 *
 * ★ 这样做只有一个目的：**让小程序代码在 Node 里也能测**。
 *   测试里 setPlatform({...}) 换成假的，就能跑完整的登录、预定、核销流程，
 *   不需要开发者工具、不需要真机、不需要联网。
 *
 *   真实的 wx API 都是「成功回调 / 失败回调」风格，这里统一转成 Promise。
 */

let impl = {
  request(options) {
    return new Promise((resolve, reject) => {
      wx.request({
        ...options,
        success: resolve,
        fail: reject,
      });
    });
  },

  login() {
    return new Promise((resolve, reject) => {
      wx.login({ success: resolve, fail: reject });
    });
  },

  scanCode() {
    return new Promise((resolve, reject) => {
      wx.scanCode({
        onlyFromCamera: false,
        scanType: ['qrCode', 'barCode'],
        success: resolve,
        fail: reject,
      });
    });
  },

  getStorage(key) {
    try { return wx.getStorageSync(key) || null; } catch { return null; }
  },
  setStorage(key, value) {
    try { wx.setStorageSync(key, value); } catch { /* 存储满了也不该崩 */ }
  },
  removeStorage(key) {
    try { wx.removeStorageSync(key); } catch { /* 忽略 */ }
  },

  showToast({ title, icon = 'none', duration = 1800 }) {
    wx.showToast({ title, icon, duration });
  },

  /** 取货码页要把屏幕调到最亮，方便志愿者扫 */
  setScreenBrightness(value) {
    try { wx.setScreenBrightness({ value }); } catch { /* 不支持就算了 */ }
  },
  getScreenBrightness() {
    try { return wx.getScreenBrightness().value; } catch { return null; }
  },
};

/** 测试用：替换掉部分或全部实现 */
export function setPlatform(patch) {
  impl = { ...impl, ...patch };
}

export function resetPlatform(original) {
  impl = original;
}

export const platform = () => impl;

export const originalPlatform = impl;
