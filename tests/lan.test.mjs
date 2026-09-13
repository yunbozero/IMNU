/**
 * 局域网地址探测的测试
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lanUrls } from '../scripts/lan.mjs';

test('局域网：跳过回环地址，只保留可被手机访问的 IPv4', () => {
  const ifaces = {
    'Loopback Pseudo-Interface 1': [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: '::1', family: 'IPv6', internal: true },
    ],
    'WLAN': [
      { address: '192.168.1.23', family: 'IPv4', internal: false },
      { address: 'fe80::1234', family: 'IPv6', internal: false },
    ],
  };
  const urls = lanUrls(ifaces, 8080);
  assert.deepEqual(urls, [{ iface: 'WLAN', url: 'http://192.168.1.23:8080/' }]);
});

test('局域网：兼容 family 为数字 4 的旧版 Node', () => {
  const ifaces = {
    eth0: [{ address: '10.0.0.7', family: 4, internal: false }],
  };
  assert.deepEqual(lanUrls(ifaces, 9000), [
    { iface: 'eth0', url: 'http://10.0.0.7:9000/' },
  ]);
});

test('局域网：多网卡时全部列出（有线 + 无线）', () => {
  const ifaces = {
    WLAN: [{ address: '192.168.1.23', family: 'IPv4', internal: false }],
    '以太网': [{ address: '192.168.1.88', family: 'IPv4', internal: false }],
  };
  const urls = lanUrls(ifaces, 8080).map((u) => u.url);
  assert.equal(urls.length, 2);
  assert.ok(urls.includes('http://192.168.1.23:8080/'));
  assert.ok(urls.includes('http://192.168.1.88:8080/'));
});

test('局域网：没有可用网卡时返回空数组，不抛错', () => {
  assert.deepEqual(lanUrls({}, 8080), []);
  assert.deepEqual(lanUrls(null, 8080), []);
  assert.deepEqual(lanUrls(undefined, 8080), []);
  assert.deepEqual(lanUrls({ WLAN: null }, 8080), []);
});

test('局域网：端口会体现在地址里', () => {
  const ifaces = { WLAN: [{ address: '192.168.0.5', family: 'IPv4', internal: false }] };
  assert.equal(lanUrls(ifaces, 3000)[0].url, 'http://192.168.0.5:3000/');
});
