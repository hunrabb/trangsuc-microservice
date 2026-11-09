import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRoute } from './routes.ts';
import { rateLimitsFor } from './rate-limit-rules.ts';

test('manual payment confirmation requires backoffice route, never maps shop path to admin', () => {
  const suffix = '/branches/b/online-orders/o/payments/confirm';
  assert.deepEqual(resolveRoute(`/api/admin/sales${suffix}`), {
    service: 'sales',
    path: `/admin${suffix}`,
    audience: 'backoffice',
  });
  assert.equal(resolveRoute(`/api/shop${suffix}`)?.path, `/shop${suffix}`);
  assert.equal(resolveRoute('/api/shop/internal/payments'), undefined);
  assert.equal(resolveRoute('/internal/payments'), undefined);
});
test('privileged payment POST rate limits normalize encoded/case paths and include refund requests', () => {
  for (const path of [
    '/admin/branches/b/online-orders/o/payments/confirm',
    '/admin/branches/b/online-orders/o/PAYMENTS/p/refund-request/',
    '/admin/branches/b/online-orders/o/%70ayments/confirm',
  ])
    assert.deepEqual(rateLimitsFor('POST', path, 'ip', undefined), [
      { key: 'payment-admin:ip:ip', limit: 20, ttlMs: 60000 },
    ]);
});
