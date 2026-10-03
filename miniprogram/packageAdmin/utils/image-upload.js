/**
 * 选一张物品照片并传上去。
 *
 * 两个页面共用：新建物品（配图）和物品名额（给已有的物品换图）。
 *
 * 三步：
 *   1. `wx.chooseMedia({ sizeType: ['compressed'] })` —— ★ 让微信**直接给压缩过的版本**，
 *      这一步比后面所有补救都管用
 *   2. `wx.compressImage` —— 再压一道兜底
 *   3. 读成 base64，走普通 JSON 接口传上去
 *
 * ★ 为什么不用 `wx.uploadFile`：它是 multipart，服务端得在零依赖的前提下解析
 *   边界字符串、CRLF 和分块 —— 那是整条上传链路里唯一真正麻烦的部分。
 *   走 base64 服务端只需要 `Buffer.from(s, 'base64')`。代价是体积大 1/3，
 *   而这里已经压到 100–300KB，可以忽略。
 * ★ 压缩必须在**客户端**做：手机原图 3–5MB，几十件就是几百 MB，
 *   义卖当天的现场网络根本传不动。
 */
import * as api from '../../services/api.js';

/**
 * 上限。**必须和服务端 server/images.mjs 一致** —— 有测试逐个比对。
 * 客户端也拦一道是为了省流量：传了 3MB 上去再被 413 顶回来，很亏。
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64;

/** 压缩质量。70 在手机上几乎看不出差别，体积能掉到三分之一左右。 */
export const COMPRESS_QUALITY = 70;

export const MAX_IMAGE_KB = Math.round(MAX_IMAGE_BYTES / 1024);

/** 选图。用户取消返回 null（取消不是错误，界面不该弹提示）。 */
function chooseImage() {
  return new Promise((resolve) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const f = res && res.tempFiles && res.tempFiles[0];
        resolve(f ? f.tempFilePath : null);
      },
      fail: () => resolve(null),   // 取消和失败都走这里，一律当成「没选」
    });
  });
}

/** 再压一道。压不动就用原图 —— 不能因为「压缩失败」就不让人传图。 */
function compressIfPossible(src) {
  return new Promise((resolve) => {
    if (typeof wx.compressImage !== 'function') return resolve(src);
    wx.compressImage({
      src,
      quality: COMPRESS_QUALITY,
      success: (res) => resolve((res && res.tempFilePath) || src),
      fail: () => resolve(src),
    });
  });
}

function readBase64(filePath) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (res) => resolve(res && res.data ? res.data : null),
      fail: () => resolve(null),
    });
  });
}

/**
 * 让用户选一张图，压缩后传上去。
 *
 * @returns {Promise<
 *   {ok: true, image: string, url: string, previewPath: string}
 *   | {ok: false, cancelled: true}
 *   | {ok: false, message: string}
 * >}
 * 成功时：`image` 是服务端生成的文件名（存进物品用），`previewPath` 是本地临时路径
 * （拿它做预览比用远端地址快，而且不依赖网络）。
 */
export async function pickAndUploadImage({ token } = {}) {
  const picked = await chooseImage();
  if (!picked) return { ok: false, cancelled: true };

  // 上传要一两秒，中途没反馈会让人以为点空了
  wx.showLoading({ title: '上传中…', mask: true });
  try {
    const compressed = await compressIfPossible(picked);
    const base64 = await readBase64(compressed);
    if (!base64) return { ok: false, message: '读不出这张图片，换一张试试' };

    if (base64.length > MAX_IMAGE_BASE64) {
      return { ok: false, message: `图片超过 ${MAX_IMAGE_KB}KB，先裁小一点再传` };
    }

    const r = await api.post('/api/admin/image', { token, body: { image: base64 } });
    return {
      ok: true,
      image: r.image,
      url: r.url,
      previewPath: compressed,
    };
  } catch (e) {
    return { ok: false, message: (e && e.message) || '上传失败，请重试' };
  } finally {
    wx.hideLoading();
  }
}

/** 统一的失败提示：取消不提示，其它把原因弹出来 */
export function reportImageResult(res) {
  if (!res.ok && !res.cancelled) {
    wx.showToast({ title: res.message || '没传上去', icon: 'none' });
  }
}
