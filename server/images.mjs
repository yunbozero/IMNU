/**
 * 物品照片的存储。
 *
 * 照片就存在服务器磁盘上，nginx 直接发文件；Node 这边也提供了一个
 * `/images/` 的静态服务 —— 本地开发没有 nginx，而开发者工具连的正是 Node 自己。
 * 两边读的是同一个目录，所以「本地能看到、线上看不到」这种差异不会出现。
 *
 * ★ 文件名**永远由服务端生成**，绝不拼接客户端传来的任何字符串。
 *   于是路径穿越（`../../etc/passwd`）这类问题从一开始就不存在，
 *   而不是靠一个过滤函数去挡。
 * ★ 落盘是「先写临时文件再 rename」：中途失败不会留下半张图，
 *   而同一文件系统内的 rename 是原子的。
 * ★ 类型判断看**魔术字节**，不看客户端给的 content-type ——
 *   后者是客户端说了算的，把 .exe 改名成 .jpg 就能骗过去。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 本地联调用的目录，放在已被 .gitignore 挡掉的 tmp/ 下 */
export const DEV_IMAGE_DIR = 'tmp/images';
/** 线上目录。和数据库一样在 /srv/bazaar 下，备份脚本不管它（图片丢了重传一遍即可） */
export const PROD_IMAGE_DIR = '/srv/bazaar/images';

/**
 * 单张图的体积上限（**解码之后**的字节数）。
 *
 * 小程序那边会先压缩（`sizeType: compressed` + `compressImage`），
 * 实际传上来的在 100–300KB；2MB 是给「压缩没生效」留的余量。
 * 不设上限的话，一张 20MB 的原图能顺着请求体进来，把内存和磁盘都吃掉。
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** base64 之后的大小上限。base64 每 3 字节变 4 字符，再留一点余量。 */
export const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64;

/**
 * 认得的图片类型。**只收这四种** —— 都是 `<image>` 组件稳定支持的格式。
 * 顺序有讲究：webp 要先看 RIFF，但 RIFF 也是 wav/avi 的头，
 * 所以必须再看第 8 字节是不是 WEBP。
 */
const SIGNATURES = [
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  {
    ext: 'png', mime: 'image/png',
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47
      && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A,
  },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.slice(0, 4).toString('latin1') === 'GIF8' },
  {
    ext: 'webp', mime: 'image/webp',
    test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF'
      && b.slice(8, 12).toString('latin1') === 'WEBP',
  },
];

/** 服务端生成的文件名长这样。任何不符合的字符串都不会被当成路径用。 */
const NAME_RE = /^img_[0-9a-f]{32}\.(jpg|png|webp|gif)$/;

/** 是不是我们自己生成的文件名。用它可以安全地拼路径。 */
export const isImageName = (name) => typeof name === 'string' && NAME_RE.test(name);

/** 看魔术字节认类型。认不出来返回 null。 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  return SIGNATURES.find((s) => s.test(buf)) || null;
}

/** 库里的 image 列存的只是文件名；这里把它变成一个能直接给 `<image src>` 用的 URL */
export const imageUrlOf = (name) => (isImageName(name) ? `/images/${name}` : null);

/** 文件名 → content-type。名字不合法时返回 octet-stream（反正也读不到文件）。 */
export function mimeOfName(name) {
  if (!isImageName(name)) return 'application/octet-stream';
  const ext = name.slice(name.lastIndexOf('.') + 1);
  const hit = SIGNATURES.find((s) => s.ext === ext);
  return hit ? hit.mime : 'application/octet-stream';
}

/**
 * 先验一遍「这张图能不能收」，**不落盘**。
 *
 * saveImage 和「导入前预检」（scripts/init-event.mjs）共用它。
 * ★ 分成两份判断的话，某个格式会在一处放行、另一处拒绝，
 *   症状是「界面明明传得上去，脚本却说不行」—— 这种不一致极难查。
 */
export function validateImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, reason: 'empty' };
  if (buf.length > MAX_IMAGE_BYTES) {
    return { ok: false, reason: 'too_large', limit: MAX_IMAGE_BYTES };
  }

  const sig = sniffImage(buf);
  if (!sig) return { ok: false, reason: 'not_image' };

  return { ok: true, ext: sig.ext, mime: sig.mime, bytes: buf.length };
}

/** 把「为什么不行」翻成人话。错误原因只有一处定义，说法才不会两边不一致。 */
export function imageProblemText(reason, limit = MAX_IMAGE_BYTES) {
  return {
    empty: '文件是空的',
    too_large: `超过 ${Math.round(limit / 1024)}KB`,
    not_image: '不是 JPG / PNG / WebP / GIF 图片',
  }[reason] || '用不了';
}

/**
 * 存一张图。
 * @returns {{ok: true, name: string}} 或 {{ok: false, reason: 'empty'|'too_large'|'not_image'}}
 */
export function saveImage(buf, dir) {
  const v = validateImage(buf);
  if (!v.ok) return v;

  fs.mkdirSync(dir, { recursive: true });

  const name = `img_${randomUUID().replace(/-/g, '')}.${v.ext}`;
  const tmp = path.join(dir, `.tmp-${randomUUID()}`);

  // 先写全再 rename：中途断电/失败最多留下一个临时文件，
  // 不会出现一个「存在但内容是半张图」的正式文件
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, path.join(dir, name));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败就算了，临时文件不影响功能 */ }
    throw e;
  }

  return { ok: true, name, mime: v.mime, bytes: v.bytes };
}

/**
 * 删一张图。**尽最大努力，绝不抛错** ——
 * 调用它的时候（换图/清空图片）数据已经改完了，为了一张删不掉的旧图
 * 让整个请求失败是本末倒置；最坏结果只是磁盘上多一个没人引用的文件。
 */
export function deleteImage(name, dir) {
  if (!isImageName(name)) return false;
  try {
    fs.unlinkSync(path.join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/** 读一张图，给静态服务用。名字不合法或文件不在都返回 null。 */
export function readImage(name, dir) {
  if (!isImageName(name)) return null;
  try {
    return fs.readFileSync(path.join(dir, name));
  } catch {
    return null;
  }
}

/**
 * 这张图在不在磁盘上。
 *
 * 建/改物品时要查一下：库里存的是文件名，如果文件其实不在（上传到一半失败、
 * 手工删了目录），`<image>` 只会显示一个破图标，而且**不会**回落到 emoji ——
 * 因为界面判断「有没有图」看的就是这个文件名。宁可当时就拒绝，也别留个破图。
 */
export function imageExists(name, dir) {
  if (!isImageName(name)) return false;
  try {
    return fs.statSync(path.join(dir, name)).isFile();
  } catch {
    return false;
  }
}
