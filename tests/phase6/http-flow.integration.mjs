// PREPARED FOR 6.5B ONLY. Does not start servers, migrate, run Docker, or clean shared data.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  requireAcknowledgement,
  databaseUrl,
  gatewayUrl,
  rabbitUrl,
  FIXTURE,
} from './test-environment.mjs';
const require = createRequire(import.meta.url);
const commonRequire = createRequire(new URL('../../libs/common/package.json', import.meta.url));
const contracts = require('../../libs/contracts/dist/index.js');
const { SignJWT, importPKCS8 } = commonRequire('jose');
let stage = 'preflight';
async function main() {
  requireAcknowledgement();
  databaseUrl(process.env.PHASE6_TEST_INVENTORY_URL, 'inventory');
  databaseUrl(process.env.PHASE6_TEST_SALES_URL, 'sales');
  rabbitUrl(process.env.PHASE6_TEST_RABBITMQ_URL);
  const base = gatewayUrl(process.env.PHASE6_TEST_GATEWAY_URL);
  if (!process.env.PHASE6_TEST_PRIVATE_KEY_PATH) throw new Error('Test signing key is required');
  const privateKey = await importPKCS8(
    readFileSync(process.env.PHASE6_TEST_PRIVATE_KEY_PATH, 'utf8'),
    'RS256',
  );
  const actor = randomUUID();
  const sign = (branches, actorId = actor) =>
    new SignJWT({ branches })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setSubject(actorId)
      .setIssuer('phase6-acceptance')
      .setAudience('phase6-backoffice')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(privateKey);
  const manager = await sign([{ role: 'MANAGER', branchId: FIXTURE.branch }]);
  const secondManager = await sign([{ role: 'MANAGER', branchId: FIXTURE.branch }], randomUUID());
  const staff = await sign([{ role: 'STAFF', branchId: FIXTURE.branch }]);
  const other = await sign([{ role: 'MANAGER', branchId: randomUUID() }]);
  const admin = await sign([{ role: 'ADMIN', branchId: null }]);
  async function request(path, { method = 'GET', auth, key, body, status = 200 } = {}) {
    const headers = {
      Accept: 'application/json',
      ...(auth ? { Authorization: auth } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    };
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(res.status, status, `${stage}: unexpected HTTP status`);
    const data = await res.json();
    return data;
  }
  async function poll(work, done) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const value = await work();
      if (done(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error('Timed out waiting for real asynchronous services');
  }
  stage = 'private test-key authorization';
  await request('/api/admin/inventory/products?page=1&pageSize=1', { auth: `Bearer ${admin}` });
  await request(
    `/api/admin/sales/branches/${FIXTURE.branch}/online-orders/${randomUUID()}/payments`,
    { auth: `Bearer ${manager}`, status: 404 },
  );
  stage = 'catalog outbox/broker projection';
  // Operator waits for the first publisher tick before invoking this script.
  const catalog = contracts.shopProductSchema.parse(
    await request(`/api/shop/products/${FIXTURE.product}`),
  );
  assert.equal(catalog.inStock, true);
  assert.equal(catalog.variants[0].estimatedPrice, '2600000.00');
  stage = 'gateway validation and checkout idempotency';
  const token = randomBytes(32).toString('hex'),
    key = `PH6ACCEPT-${randomUUID()}`,
    access = `Checkout ${token}`;
  const body = {
    items: [{ variantId: FIXTURE.variant, quantity: 1 }],
    recipientName: 'PH6ACCEPT Test',
    recipientPhone: '0901234567',
    shippingAddress: 'PH6ACCEPT isolated test address',
  };
  const evidence = join(mkdtempSync(join(tmpdir(), 'phase6-access-')), 'access.json');
  writeFileSync(evidence, JSON.stringify({ token, key, productId: FIXTURE.product }), {
    mode: 0o600,
    flag: 'wx',
  });
  await request('/api/shop/orders', {
    method: 'POST',
    auth: access,
    key: `${key}-invalid`,
    body: { ...body, total: '1.00' },
    status: 400,
  });
  const create = () =>
    request('/api/shop/orders', { method: 'POST', auth: access, key, body, status: 202 });
  const [a, b] = await Promise.all([create(), create()]);
  assert.equal(a.id, b.id);
  const id = a.id;
  writeFileSync(evidence, JSON.stringify({ token, key, orderId: id, productId: FIXTURE.product }), {
    mode: 0o600,
  });
  assert.equal((await request('/api/shop/orders/by-key', { auth: access, key })).id, id);
  await request(`/api/shop/orders/${id}`, {
    auth: `Checkout ${randomBytes(32).toString('hex')}`,
    status: 404,
  });
  await request('/api/shop/internal/stock', { status: 404 });
  stage = 'real Inventory reservation acknowledgement';
  const reserved = await poll(
    async () =>
      contracts.onlineOrderViewSchema.parse(
        await request(`/api/shop/orders/${id}`, { auth: access }),
      ),
    (view) => view.status !== 'PENDING',
  );
  assert.equal(reserved.status, 'AWAITING_PAYMENT');
  assert.equal(reserved.total, '2600000.00');
  assert.equal(reserved.items.length, 1);
  const payments = `/api/admin/sales/branches/${FIXTURE.branch}/online-orders/${id}/payments`;
  const receipt = {
    bankTxnRef: `PH6ACCEPT/${randomUUID()}`,
    amount: reserved.total,
    currency: 'VND',
    evidenceRef: 'PH6ACCEPT/synthetic-statement-no-real-money',
  };
  stage = 'receipt role and branch enforcement';
  for (const auth of [`Bearer ${staff}`, `Bearer ${other}`])
    await request(`${payments}/confirm`, { method: 'POST', auth, key, body: receipt, status: 403 });
  await request(payments, { status: 401 });
  stage = 'concurrent duplicate receipt and real paid hold acknowledgement';
  const confirm = (staffToken = manager) =>
    request(`${payments}/confirm`, {
      method: 'POST',
      auth: `Bearer ${staffToken}`,
      key: `${key}-receipt`,
      body: receipt,
    });
  const [payment, duplicate] = await Promise.all([confirm(), confirm(secondManager)]);
  assert.equal(payment.id, duplicate.id);
  assert.equal((await confirm()).id, payment.id);
  const confirmed = await poll(
    async () =>
      contracts.onlineOrderViewSchema.parse(
        await request(`/api/shop/orders/${id}`, { auth: access }),
      ),
    (view) => ['CONFIRMED', 'PAYMENT_REVIEW', 'REFUND_PENDING'].includes(view.status),
  );
  assert.equal(confirmed.status, 'CONFIRMED');
  await request(`/api/shop/orders/${id}/cancel`, { method: 'POST', auth: access, status: 409 });
  const receipts = await request(payments, { auth: `Bearer ${manager}` });
  assert.equal(receipts.length, 1);
  for (const field of [
    'accessHash',
    'recipientPhone',
    'bankTxnRef',
    'evidenceRef',
    'warehouseId',
    'branchId',
  ])
    assert.ok(!(field in confirmed));
  stage = 'refund request semantics';
  const refund = await request(`${payments}/${payment.id}/refund-request`, {
    method: 'POST',
    auth: `Bearer ${manager}`,
    body: { reason: 'PH6ACCEPT request only, no actual refund' },
  });
  assert.equal(refund.status, 'REFUND_PENDING');
  assert.equal(
    (await request(`/api/shop/orders/${id}`, { auth: access })).status,
    'REFUND_PENDING',
  );
  console.log(
    JSON.stringify({
      result: 'PASS',
      scope: 'real HTTP and asynchronous broker flow; no browser or real bank',
      orderId: id,
      paymentId: payment.id,
      privateAccessFile: evidence,
    }),
  );
}
main().catch(() => {
  console.error(
    `FAIL/NOT VERIFIED at ${stage}. Keep the isolated data and private evidence for diagnosis; credentials are not printed.`,
  );
  process.exitCode = 1;
});
