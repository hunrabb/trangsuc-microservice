import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveRoute } from './routes.ts';
import { rateLimitsFor } from './rate-limit-rules.ts';

test('public catalog uses Sales, keeps admin authenticated and blocks internal paths', () => {
  assert.deepEqual(resolveRoute('/api/shop/products?page=1'), {
    service: 'sales',
    path: '/shop/products?page=1',
    audience: null,
  });
  assert.equal(resolveRoute('/api/admin/inventory/products')?.audience, 'backoffice');
  for (const path of [
    '/internal/catalog',
    '/api/shop/internal/catalog',
    '/api/shop/%69nternal/catalog',
    '/api/shop/products/../internal',
    '/api/shop/products/%2e%2e/internal',
    '/api/shop/products/%2fadmin',
    '/api/shop/products/../../admin',
  ])
    assert.equal(resolveRoute(path), undefined);
});
test('catalog GET/HEAD share one normalized per-IP limit including encoded/case paths', () => {
  const expected = [{ key: 'catalog:ip:127.0.0.1', limit: 120, ttlMs: 60000 }];
  for (const path of ['/shop/products', '/shop/PRODUCTS/?page=1', '/shop/%70roducts/id'])
    for (const method of ['GET', 'HEAD'])
      assert.deepEqual(rateLimitsFor(method, path, '127.0.0.1', undefined), expected);
  assert.deepEqual(rateLimitsFor('GET', '/admin/products', '127.0.0.1', undefined), []);
});
