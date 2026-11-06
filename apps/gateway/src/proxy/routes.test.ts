import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveRoute } from './routes.ts';

describe('resolveRoute', () => {
  const cases: [string, string, string, boolean][] = [
    ['/api/auth/login', 'auth', '/auth/login', false],
    ['/api/pos/orders', 'sales', '/pos/orders', true],
    ['/api/online-orders/1', 'sales', '/online-orders/1', true],
    ['/api/shop/products?page=2&q=a%20b', 'sales', '/shop/products?page=2&q=a%20b', false],
    ['/api/admin/auth/users', 'auth', '/admin/users', true],
    ['/api/admin/inventory/products/1', 'inventory', '/admin/products/1', true],
    ['/api/admin/sales/pos/x', 'sales', '/admin/pos/x', true],
    ['/api/admin/reports/daily', 'report', '/admin/daily', true],
    ['/webhooks/bank', 'sales', '/webhooks/bank', false],
    ['/api/admin/reports', 'report', '/admin', true],
    ['/api/pos/orders/', 'sales', '/pos/orders/', true],
  ];
  for (const [url, service, path, requiresAuth] of cases) {
    it(`${url} → ${service} ${path}`, () => {
      assert.deepEqual(resolveRoute(url), { service, path, requiresAuth });
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
      '/webhooks/bank/x',
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

  it('không có đường nào tới /health/* của service', () => {
    for (const url of [
      '/api/admin/inventory/health/ready',
      '/api/admin/inventory/health',
      '/api/admin/sales/HEALTH/live',
      '/api/admin/reports/%68ealth/ready',
      '/api/admin/auth/health/',
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
