import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { resolveRoute } from './routes.ts';

describe('resolveRoute', () => {
  const cases: [string, string, string, 'backoffice' | null][] = [
    ['/api/auth/login', 'auth', '/auth/login', null],
    ['/api/pos/orders', 'sales', '/pos/orders', 'backoffice'],
    ['/api/online-orders/1', 'sales', '/online-orders/1', 'backoffice'],
    ['/api/shop/auth/login', 'auth', '/shop/auth/login', null],
    ['/api/shop/auth', 'auth', '/shop/auth', null],
    ['/api/shop/authx', 'sales', '/shop/authx', null],
    ['/api/shop/products?page=2&q=a%20b', 'sales', '/shop/products?page=2&q=a%20b', null],
    ['/api/admin/auth/users', 'auth', '/admin/users', 'backoffice'],
    ['/api/admin/inventory/products/1', 'inventory', '/admin/products/1', 'backoffice'],
    ['/api/admin/sales/pos/x', 'sales', '/admin/pos/x', 'backoffice'],
    ['/api/admin/reports/daily', 'report', '/admin/daily', 'backoffice'],
    ['/api/admin/reports/buybacks', 'report', '/admin/buybacks', 'backoffice'],
    ['/webhooks/bank', 'sales', '/webhooks/bank', null],
    ['/api/admin/reports', 'report', '/admin', 'backoffice'],
    ['/api/pos/orders/', 'sales', '/pos/orders/', 'backoffice'],
  ];
  for (const [url, service, path, audience] of cases) {
    it(`${url} → ${service} ${path}`, () => {
      assert.deepEqual(resolveRoute(url), { service, path, audience });
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

  it('mọi đường trong auth.openapi.yaml đều đi qua bảng định tuyến tới auth', () => {
    const spec = readFileSync(resolve('../../docs/api/auth.openapi.yaml'), 'utf8');
    const paths = [...spec.matchAll(/^ {2}(\/api\/[^:]+):$/gm)].map((match) => match[1] ?? '');
    assert.ok(paths.length >= 17, `chỉ thấy ${paths.length} đường`);
    for (const path of paths) {
      const url = path.replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000000');
      assert.equal(resolveRoute(url)?.service, 'auth', path);
    }
  });
});
