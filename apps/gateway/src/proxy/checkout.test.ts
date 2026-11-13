import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rateLimitsFor } from './rate-limit-rules.ts';
import { resolveRoute } from './routes.ts';
import { forwardRequestHeaders } from './headers.ts';

test('checkout public gateway routes only to Sales and forwards capability header', () => {
  assert.deepEqual(resolveRoute('/api/shop/orders'), {
    service: 'sales',
    path: '/shop/orders',
    audience: null,
  });
  assert.equal(resolveRoute('/api/admin/inventory/products')?.audience, 'backoffice');
  for (const url of [
    '/internal/reservations',
    '/api/shop/internal/reservations',
    '/api/shop/orders/../internal/reservations',
    '/api/shop/%69nternal/reservations',
  ])
    assert.equal(resolveRoute(url), undefined);
  assert.equal(
    forwardRequestHeaders({ authorization: 'Checkout secret' }, 'correlation').authorization,
    'Checkout secret',
  );
});
test('checkout creation and cancellation share rate bucket; polling is bounded and cannot bypass via spelling', () => {
  for (const path of [
    '/shop/orders',
    '/shop/ORDERS/id/cancel/',
    '/shop/%6frders',
    '/shop/my-orders',
    '/shop/MY-ORDERS/id/cancel/',
    '/shop/%6dy-orders',
  ]) {
    assert.deepEqual(rateLimitsFor('POST', path, 'ip', undefined), [
      { key: 'checkout:ip:ip', limit: 10, ttlMs: 60000 },
    ]);
    for (const method of ['GET', 'HEAD'])
      assert.deepEqual(rateLimitsFor(method, path, 'ip', undefined), [
        { key: 'online-order:ip:ip', limit: 120, ttlMs: 60000 },
      ]);
  }
});

test('my-orders requires shop JWT at gateway; staff APIs keep backoffice audience', () => {
  for (const path of ['/api/shop/my-orders', '/api/shop/my-orders/id?page=1']) {
    const route = resolveRoute(path);
    assert.equal(route?.audience, 'shop');
    assert.equal(route?.service, 'sales');
  }
  assert.equal(resolveRoute('/api/online-orders')?.audience, 'backoffice');
  assert.equal(resolveRoute('/api/shop/orders')?.audience, null);
  for (const path of ['/shop/auth/login', '/shop/auth/register']) {
    assert.ok(
      rateLimitsFor('POST', path, 'ip', Buffer.from('{"email":"a@example.com"}')).length > 0,
    );
  }
});
