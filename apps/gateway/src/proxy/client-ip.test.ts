import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseTrustedProxies, resolveClientIp } from './client-ip.ts';

const NGINX = '172.30.0.16';
const proxies = parseTrustedProxies('172.30.0.16/31,10.0.0.5');

describe('resolveClientIp', () => {
  it('kết nối trực tiếp: bỏ qua X-Forwarded-For giả', () => {
    assert.equal(resolveClientIp('203.0.113.7', '1.2.3.4', proxies), '203.0.113.7');
  });

  it('địa chỉ bridge của Docker không phải proxy tin cậy', () => {
    assert.equal(resolveClientIp('172.30.0.1', '1.2.3.4', proxies), '172.30.0.1');
  });

  it('qua nginx: lấy địa chỉ nginx thấy, bỏ phần client tự viết ở đầu chuỗi', () => {
    assert.equal(resolveClientIp(NGINX, '1.2.3.4, 203.0.113.7', proxies), '203.0.113.7');
  });

  it('qua nhiều proxy tin cậy: bỏ các proxy, lấy địa chỉ đầu tiên không tin cậy từ phải', () => {
    assert.equal(resolveClientIp(NGINX, '1.2.3.4, 203.0.113.7, 10.0.0.5', proxies), '203.0.113.7');
  });

  it('proxy tin cậy nhưng không có X-Forwarded-For: dùng địa chỉ kết nối', () => {
    assert.equal(resolveClientIp(NGINX, undefined, proxies), NGINX);
    assert.equal(resolveClientIp(NGINX, 'rac, khong-phai-ip', proxies), NGINX);
  });

  it('chuẩn hoá địa chỉ IPv4 dạng IPv6', () => {
    assert.equal(resolveClientIp('::ffff:127.0.0.2', undefined, proxies), '127.0.0.2');
    assert.equal(resolveClientIp(`::ffff:${NGINX}`, '::ffff:203.0.113.7', proxies), '203.0.113.7');
  });

  it('danh sách rỗng: không tin ai', () => {
    assert.equal(resolveClientIp(NGINX, '1.2.3.4', parseTrustedProxies('')), NGINX);
  });

  it('nhận cả IPv6', () => {
    const v6 = parseTrustedProxies('fd00::/8');
    assert.equal(resolveClientIp('fd00::1', '2001:db8::1', v6), '2001:db8::1');
  });
});
