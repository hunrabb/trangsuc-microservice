import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveRoute } from './routes.ts';

describe('resolveRoute', () => {
  const cases: [string, string, string][] = [
    ['/api/pos/orders', 'sales', '/pos/orders'],
    ['/api/shop/products?page=2&q=a%20b', 'sales', '/shop/products?page=2&q=a%20b'],
    ['/api/online-orders/1', 'sales', '/online-orders/1'],
    ['/api/admin/auth/login', 'auth', '/login'],
    ['/api/admin/inventory/products/1', 'inventory', '/products/1'],
    ['/api/admin/sales/orders', 'sales', '/orders'],
    ['/api/admin/reports/daily', 'report', '/daily'],
    ['/webhooks/bank', 'sales', '/webhooks/bank'],
    ['/api/admin/reports', 'report', '/'],
    ['/api/pos/orders/', 'sales', '/pos/orders/'],
  ];
  for (const [url, service, path] of cases) {
    it(`${url} → ${service} ${path}`, () => {
      assert.deepEqual(resolveRoute(url), { service, path });
    });
  }

  it('không khớp bảng thì không có đích', () => {
    for (const url of [
      '/api/khong-co',
      '/api/posx/1',
      '/api/admin',
      '/api/admin/khac/x',
      '/webhooks/khac',
      '/webhooks/bankx',
      '/API/pos/x',
      'http://evil/api/pos/x',
    ]) {
      assert.equal(resolveRoute(url), undefined, url);
    }
  });

  it('không có đường nào tới /internal/* của service', () => {
    for (const url of [
      '/api/admin/inventory/internal/ping',
      '/api/admin/inventory/internal',
      '/api/admin/inventory/INTERNAL/ping',
      '/api/admin/inventory/%69nternal/ping',
      '/api/admin/sales/internal/stock?x=1',
      '/api/admin/auth/Internal/x',
      '/api/admin/reports/internal/',
    ]) {
      assert.equal(resolveRoute(url), undefined, url);
    }
  });

  it('chặn dot-segment, dấu gạch mã hoá, gạch ngược, // và mã hoá hỏng', () => {
    for (const url of [
      '/api/pos/../internal/ping',
      '/api/pos/%2e%2e/internal/ping',
      '/api/pos/%2E%2E%2Finternal/ping',
      '/api/pos/.%2e/internal/ping',
      '/api/pos/./x',
      '/api/pos/x%2finternal',
      '/api/pos/x%5cinternal',
      '/api/pos/x\\..\\internal',
      '/api/pos//internal/ping',
      '/api/admin/inventory//evil.example/x',
      '/api/pos/%00',
      '/api/pos/%zz',
    ]) {
      assert.equal(resolveRoute(url), undefined, url);
    }
  });
});
