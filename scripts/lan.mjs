/**
 * 局域网地址探测（纯函数，便于测试）
 *
 * 手机和电脑连同一个 WiFi 时，手机可以直接访问电脑上的原型。
 * 不经过微信、不需要域名、不需要备案。
 */

/**
 * @param {object} interfaces  os.networkInterfaces() 的返回值
 * @param {number} port        监听端口
 * @param {string} protocol    默认 http
 * @returns {{iface: string, url: string}[]}
 */
export function lanUrls(interfaces, port, protocol = 'http') {
  const out = [];
  for (const [iface, addrs] of Object.entries(interfaces || {})) {
    for (const a of addrs || []) {
      if (!a) continue;
      // Node 18 起 family 是字符串 'IPv4'，更早是数字 4
      const isV4 = a.family === 'IPv4' || a.family === 4;
      if (!isV4) continue;
      if (a.internal) continue;          // 跳过 127.0.0.1 / 169.254 之类的回环地址
      out.push({ iface, url: `${protocol}://${a.address}:${port}/` });
    }
  }
  return out;
}
