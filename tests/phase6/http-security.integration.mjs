// Small, sequential Gateway-only security checks. Run last: consumes catalog rate budget.
import assert from 'node:assert/strict';
import test from 'node:test';
import { requireAcknowledgement, gatewayUrl } from './test-environment.mjs';
requireAcknowledgement();
const base = gatewayUrl(process.env.PHASE6_TEST_GATEWAY_URL);
await test('HTTP-11: Gateway denies internal routes and encoded traversal over real HTTP', async () => {
  for (const path of [
    '/api/shop/internal/stock',
    '/api/admin/sales/internal/payments',
    '/api/shop/%69nternal/stock',
    '/internal/stock',
  ]) {
    const r = await fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 404, path);
  }
});
await test('HTTP-10: public catalog rate limiter returns 429 within configured 120/minute budget', async () => {
  let limited = false,
    accepted = 0;
  for (let n = 0; n < 125; n++) {
    const r = await fetch(base + '/api/shop/products?pageSize=1', {
      signal: AbortSignal.timeout(5000),
    });
    await r.text();
    if (r.status === 429) {
      limited = true;
      break;
    }
    assert.equal(r.status, 200);
    accepted++;
  }
  assert.ok(limited);
  assert.ok(accepted <= 120);
  console.log(
    JSON.stringify({
      rateLimit: '429 observed',
      acceptedBefore429: accepted,
      scope: 'single test Gateway, sequential requests',
    }),
  );
});
