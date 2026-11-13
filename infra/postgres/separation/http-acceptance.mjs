// Real Gateway + Nest services + four PostgreSQL instances + RabbitMQ.
// Run only against the labelled jewelry-db-separation-test containers.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertTestTarget } from './assert-test-target.mjs';

const root = resolve(import.meta.dirname, '../../..');
process.loadEnvFile(resolve(root, '.env'));
const base = 'http://127.0.0.1:13000';
const db = {};
const buybackOnly = process.argv.includes('--buyback-only');
const exchangeCase = process.argv.find((argument) => argument.startsWith('--exchange-case='))?.split('=')[1] ?? 'positive';
assert.ok(['positive', 'negative', 'zero'].includes(exchangeCase));
let stage = 'preflight', passed = 0;
const mark = (name) => { passed++; console.log(`PASS ${passed}: ${name}`); };

function assertGateway() {
  const result = spawnSync('docker', ['inspect', 'jewelry-db-separation-test-gateway-1'], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'acceptance gateway container missing');
  const [container] = JSON.parse(result.stdout);
  assert.equal(container.Config.Labels['com.docker.compose.project'], 'jewelry-db-separation-test');
  assert.equal(container.Config.Labels['com.docker.compose.service'], 'gateway');
  assert.equal(container.State.Running, true);
  assert.ok(container.NetworkSettings.Ports['3000/tcp'].some((p) => p.HostIp === '127.0.0.1' && p.HostPort === '13000'));
}

async function request(path, { method = 'GET', token, authorization, key, body, cookie, status = 200 } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      accept: 'application/json',
      ...(authorization || token ? { authorization: authorization ?? `Bearer ${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== status) {
    const failure = await response.clone().json().catch(() => ({}));
    assert.equal(response.status, status, `${stage}: HTTP ${response.status}, expected ${status}, code=${failure.code ?? failure.error?.code ?? 'unknown'}`);
  }
  return { response, data: response.status === 204 ? null : await response.json() };
}

async function poll(fn, check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (check(value)) return value;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${stage}: timed out`);
}

try {
  for (const [service, port] of [['auth', 15433], ['inventory', 15434], ['sales', 15435], ['report', 15436]]) {
    assertTestTarget(service, port);
    const password = process.env[`${service.toUpperCase()}_DB_PASSWORD`];
    assert.ok(password);
    const url = new URL(`postgresql://${service}_user@127.0.0.1:${port}/${service}_db`);
    url.password = password;
    url.searchParams.set('schema', service);
    const require = createRequire(resolve(root, `apps/${service}/package.json`));
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { PrismaClient } = require('./dist/generated/prisma/client.js');
    db[service] = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href, max: 2 }, { schema: service }) });
    const [identity] = await db[service].$queryRawUnsafe('SELECT current_database() AS db, current_user AS role');
    assert.equal(identity.db, `${service}_db`);
    assert.equal(identity.role, `${service}_user`);
  }
  assertGateway();
  await request('/api/ping');
  mark('Gateway and four independent DB targets');

  stage = 'Auth password login and refresh';
  const authRequire = createRequire(resolve(root, 'apps/auth/package.json'));
  const { hash } = authRequire('bcryptjs');
  const email = `dbaccept-${randomUUID()}@example.invalid`;
  const password = randomBytes(24).toString('base64url');
  const admin = await db.auth.user.create({
    data: {
      email,
      fullName: 'DB acceptance synthetic admin',
      passwordHash: await hash(password, 12),
      branches: { create: { role: 'ADMIN', branchId: null } },
    },
  });
  await request('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-password' }, status: 401 });
  const login = await request('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(login.data.user.id, admin.id);
  assert.ok(login.data.accessToken);
  const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const refreshed = await request('/api/auth/refresh', { method: 'POST', cookie });
  assert.ok(refreshed.data.accessToken);
  const token = refreshed.data.accessToken;
  const me = await request('/api/auth/me', { token });
  assert.equal(me.data.id, admin.id);
  assert.ok(await db.auth.refreshToken.count({ where: { userId: admin.id } }));
  mark('Auth wrong/correct login, refresh, /me and auth_db write');

  let branch, metal, first, online;
  if (!buybackOnly) {
  stage = 'branch event and Inventory warehouse';
  branch = (await request('/api/admin/auth/branches', {
    method: 'POST', token, status: 201, body: { code: `DBA-${randomUUID().slice(0, 8)}`, name: 'DB acceptance branch' },
  })).data;
  assert.ok(branch.id);
  await poll(() => db.inventory.warehouse.findUnique({ where: { branchId: branch.id } }), Boolean);
  assert.equal((await db.auth.branch.findUnique({ where: { id: branch.id } })).id, branch.id);
  mark('Auth branch.created propagated through RabbitMQ into Inventory DB');

  stage = 'Inventory catalog, price, receipt, stock';
  metal = (await request('/api/admin/inventory/metals', {
    method: 'POST', token, status: 201, body: { code: `DBA-${randomUUID().slice(0, 8)}`, name: 'DB acceptance gold', kind: 'GOLD' },
  })).data;
  await request(`/api/admin/inventory/metals/${metal.id}/prices`, {
    method: 'POST', token, status: 201, body: { buyPrice: '1000000.00', sellPrice: '2000000.00' },
  });
  const category = (await request('/api/admin/inventory/categories', {
    method: 'POST', token, status: 201, body: { name: `DB acceptance category ${randomUUID()}` },
  })).data;
  const product = (await request('/api/admin/inventory/products', {
    method: 'POST', token, status: 201, body: { categoryId: category.id, name: 'DB acceptance ring' },
  })).data;
  const variant = (await request('/api/admin/inventory/variants', {
    method: 'POST', token, status: 201, body: { productId: product.id, metalId: metal.id, sku: `DBA-${randomUUID()}`, name: 'size 12', defaultLaborFee: '100000.00' },
  })).data;
  const receipt = (await request('/api/admin/inventory/receipts', {
    method: 'POST', token, status: 201, body: { branchId: branch.id },
  })).data;
  let latest = receipt;
  const tags = [`DBA-${randomUUID()}`, `DBA-${randomUUID()}`];
  for (const tagCode of tags) {
    latest = (await request(`/api/admin/inventory/receipts/${receipt.id}/lines`, {
      method: 'POST', token, status: 201, body: { variantId: variant.id, tagCode, weight: '5.0000', costPrice: '5000000.00' },
    })).data;
  }
  await request(`/api/admin/inventory/receipts/${receipt.id}/approve`, {
    method: 'POST', token, body: { version: latest.version },
  });
  assert.equal(await db.inventory.jewelryItem.count({ where: { tagCode: { in: tags }, status: 'IN_STOCK' } }), 2);
  mark('Inventory catalog, metal price, receipt approval and two stocked items');

  stage = 'POS idempotency and payment';
  const key = `DBA-${randomUUID()}`;
  const body = { branchId: branch.id, tagCodes: [tags[0]] };
  first = (await request('/api/pos/orders', { method: 'POST', token, key, body, status: 201 })).data;
  const replay = (await request('/api/pos/orders', { method: 'POST', token, key, body, status: 201 })).data;
  assert.equal(replay.id, first.id);
  assert.equal(first.status, 'PENDING_PAYMENT');
  await request('/api/pos/orders', { method: 'POST', token, key: `DBA-${randomUUID()}`, body, status: 409 });
  const completed = (await request(`/api/pos/orders/${first.id}/confirm-payment`, { method: 'POST', token })).data;
  assert.equal(completed.status, 'COMPLETED');
  assert.equal((await db.inventory.jewelryItem.findUnique({ where: { tagCode: tags[0] } })).status, 'SOLD');
  assert.equal((await db.sales.order.findUnique({ where: { id: first.id } })).status, 'COMPLETED');
  mark('POS idempotent order, no duplicate sale, confirmed payment and two-DB state');

  stage = 'POS cancellation and release';
  const second = (await request('/api/pos/orders', {
    method: 'POST', token, status: 201, key: `DBA-${randomUUID()}`, body: { branchId: branch.id, tagCodes: [tags[1]] },
  })).data;
  const cancelled = (await request(`/api/pos/orders/${second.id}/cancel`, { method: 'POST', token })).data;
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal((await db.inventory.jewelryItem.findUnique({ where: { tagCode: tags[1] } })).status, 'IN_STOCK');
  mark('POS cancel releases second item without orphaned sale');

  stage = 'Report consumer';
  await poll(() => db.report.orderRevenue.findUnique({ where: { orderId: first.id } }), Boolean);
  const today = new Date().toISOString().slice(0, 10);
  await request(`/api/admin/reports/daily?from=${today}&to=${today}&branchId=${branch.id}`, { token });
  assert.equal(await db.report.orderRevenue.count({ where: { orderId: first.id } }), 1);
  mark('RabbitMQ order.completed consumed once into report_db and HTTP report works');

  stage = 'Online catalog and checkout';
  await request(`/api/admin/inventory/online-catalog/warehouses/${(await db.inventory.warehouse.findUnique({ where: { branchId: branch.id } })).id}`, {
    method: 'PUT', token, body: { acceptsOnlineOrders: true },
  });
  await request(`/api/admin/inventory/products/${product.id}`, {
    method: 'PATCH', token, body: { version: product.version, publishedOnline: true },
  });
  const publicProduct = await poll(async () => {
    const response = await fetch(`${base}/api/shop/products/${product.id}`, { signal: AbortSignal.timeout(10_000) });
    return response.status === 200 ? response.json() : null;
  }, (item) => item?.inStock === true);
  assert.equal(publicProduct.id, product.id);
  const checkoutToken = randomBytes(32).toString('hex');
  const checkoutAuth = `Checkout ${checkoutToken}`;
  const checkoutKey = `DBA-${randomUUID()}`;
  const checkoutBody = {
    items: [{ variantId: variant.id, quantity: 1 }],
    recipientName: 'DB acceptance guest',
    recipientPhone: '0901234567',
    shippingAddress: 'Synthetic acceptance address',
  };
  online = (await request('/api/shop/orders', {
    method: 'POST', authorization: checkoutAuth, key: checkoutKey, body: checkoutBody, status: 202,
  })).data;
  const onlineReplay = (await request('/api/shop/orders', {
    method: 'POST', authorization: checkoutAuth, key: checkoutKey, body: checkoutBody, status: 202,
  })).data;
  assert.equal(online.id, onlineReplay.id);
  const awaiting = await poll(async () => (await request(`/api/shop/orders/${online.id}`, { authorization: checkoutAuth })).data,
    (view) => view.status !== 'PENDING');
  assert.equal(awaiting.status, 'AWAITING_PAYMENT');
  assert.equal((await request('/api/shop/orders/by-key', { authorization: checkoutAuth, key: checkoutKey })).data.id, online.id);
  mark('Public catalog, checkout idempotency, guest tracking and Inventory reservation');

  stage = 'Online manual payment and idempotency';
  const paymentsPath = `/api/admin/sales/branches/${branch.id}/online-orders/${online.id}/payments`;
  const bankTxnRef = `DBA/${randomUUID()}`;
  const paymentBody = { bankTxnRef, amount: awaiting.total, currency: 'VND', evidenceRef: 'synthetic-acceptance-statement' };
  const paymentKey = `DBA-${randomUUID()}`;
  const paid = (await request(`${paymentsPath}/confirm`, {
    method: 'POST', token, key: paymentKey, body: paymentBody,
  })).data;
  const paidReplay = (await request(`${paymentsPath}/confirm`, {
    method: 'POST', token, key: paymentKey, body: paymentBody,
  })).data;
  assert.equal(paid.id, paidReplay.id);
  assert.equal(await db.sales.onlinePayment.count({ where: { bankTxnRef } }), 1);
  const paidOrder = await poll(async () => (await request(`/api/shop/orders/${online.id}`, { authorization: checkoutAuth })).data,
    (view) => view.status === 'CONFIRMED');
  assert.equal(paidOrder.status, 'CONFIRMED');
  mark('Manual online payment, unique bank reference and confirmed order');
  } else {
    let available = await db.inventory.jewelryItem.findFirst({
      where: { tagCode: { startsWith: 'DBA-' }, status: 'IN_STOCK', origin: 'STANDARD' },
      include: { warehouse: true, variant: true }, orderBy: { createdAt: 'desc' },
    });
    if (!available) {
      const prior = await db.inventory.jewelryItem.findFirst({
        where: { tagCode: { startsWith: 'DBA-' }, origin: 'STANDARD' },
        include: { warehouse: true, variant: true }, orderBy: { createdAt: 'desc' },
      });
      assert.ok(prior, 'Prior synthetic variant must exist');
      const receipt = (await request('/api/admin/inventory/receipts', { method: 'POST', token, status: 201,
        body: { branchId: prior.warehouse.branchId } })).data;
      const line = (await request(`/api/admin/inventory/receipts/${receipt.id}/lines`, { method: 'POST', token,
        status: 201, body: { variantId: prior.variantId, tagCode: `DBA-${randomUUID()}`,
          weight: '5.0000', costPrice: '5000000.00' } })).data;
      await request(`/api/admin/inventory/receipts/${receipt.id}/approve`, { method: 'POST', token,
        body: { version: line.version } });
      available = await db.inventory.jewelryItem.findFirst({ where: { warehouseId: prior.warehouseId,
        tagCode: { startsWith: 'DBA-' }, status: 'IN_STOCK', origin: 'STANDARD' },
        include: { warehouse: true, variant: true }, orderBy: { createdAt: 'desc' } });
    }
    assert.ok(available, 'Prior synthetic stocked item must exist');
    branch = await db.auth.branch.findUnique({ where: { id: available.warehouse.branchId } });
    metal = await db.inventory.metal.findUnique({ where: { id: available.variant.metalId } });
    assert.ok(branch?.code.startsWith('DBA-') && metal?.code.startsWith('DBA-'));
    mark('Reused verified synthetic stocked item, branch and metal in isolated DBs');
  }

  stage = 'Buyback appraisal, maker-checker and settlement';
  const checkerEmail = `dbaccept-checker-${randomUUID()}@example.invalid`;
  const checkerPassword = randomBytes(24).toString('base64url');
  await db.auth.user.create({ data: {
    email: checkerEmail, fullName: 'DB acceptance checker',
    passwordHash: await hash(checkerPassword, 12),
    branches: { create: { role: 'ADMIN', branchId: null } },
  } });
  const checkerToken = (await request('/api/auth/login', {
    method: 'POST', body: { email: checkerEmail, password: checkerPassword },
  })).data.accessToken;
  const buybackPath = `/api/admin/sales/branches/${branch.id}/buybacks`;
  const intake = (await request(buybackPath, { method: 'POST', token, key: `DBA-${randomUUID()}`, status: 201,
    body: { customer: { name: 'DB acceptance seller', phone: '0901234567' }, items: [{
      source: 'EXTERNAL', assetKind: 'GOLD', description: 'Synthetic old gold ring',
      condition: 'Used, intact', declaredWeight: '5.0000', initialMeasuredWeight: '5.0000',
    }] },
  })).data;
  assert.equal(intake.items.length, 1);
  const detailPath = `${buybackPath}/${intake.id}`;
  const submitted = (await request(`${detailPath}/submit`, { method: 'POST', token,
    body: { version: intake.version } })).data;
  assert.equal(submitted.status, 'PENDING_APPRAISAL');
  await request(`${detailPath}/items/${intake.items[0].id}/appraisal`, { method: 'PUT', token,
    key: `DBA-${randomUUID()}`, body: { version: submitted.version, measuredWeight: '5.0000',
      acceptedWeight: '5.0000', metalId: metal.id, metalKind: 'GOLD', purityPerMille: '999.0000', condition: 'Used, intact' } });
  const appraised = (await request(detailPath, { token })).data;
  assert.equal(appraised.status, 'APPRAISED');
  const policy = (await request(`${buybackPath}/price-policies`, { method: 'POST', token,
    key: `DBA-${randomUUID()}`, status: 201, body: { metalId: metal.id, metalKind: 'GOLD',
      purityPerMille: '999.0000', label: 'Synthetic acceptance policy',
      deductionVndPerItem: '10000.00', reason: 'Synthetic acceptance test' } })).data;
  const quote = (await request(`${detailPath}/quotes`, { method: 'POST', token,
    key: `DBA-${randomUUID()}`, status: 201, body: { version: appraised.version,
      items: [{ itemId: intake.items[0].id, policyId: policy.id, policyVersion: policy.version }] } })).data;
  const quoted = (await request(detailPath, { token })).data;
  await request(`${detailPath}/quotes/${quote.id}/approve`, { method: 'POST', token,
    key: `DBA-${randomUUID()}`, body: { version: quoted.version }, status: 403 });
  const approvedQuote = (await request(`${detailPath}/quotes/${quote.id}/approve`, { method: 'POST', token: checkerToken,
    key: `DBA-${randomUUID()}`, body: { version: quoted.version } })).data;
  assert.equal(approvedQuote.status, 'APPROVED');
  mark('Buyback intake, appraisal, quote and separate approver enforcement');

  const approvedIntake = (await request(detailPath, { token })).data;
  const settlement = (await request(`${detailPath}/settlements`, { method: 'POST', token,
    key: `DBA-${randomUUID()}`, status: 201, body: { version: approvedIntake.version, method: 'CASH' } })).data;
  assert.equal(settlement.status, 'AWAITING_PAYMENT');
  const paidSettlement = (await request(`${detailPath}/settlements/${settlement.id}/payment`, { method: 'POST', token,
    key: `DBA-${randomUUID()}`, body: { version: settlement.version,
      reference: `DBA-${randomUUID()}`, evidence: 'Synthetic acceptance cash receipt' } })).data;
  await request(`${detailPath}/settlements/${settlement.id}/confirm`, { method: 'POST', token,
    key: `DBA-${randomUUID()}`, body: { version: paidSettlement.version,
      verificationReference: `DBA-${randomUUID()}`, note: 'Synthetic checker confirmation' }, status: 403 });
  const settled = (await request(`${detailPath}/settlements/${settlement.id}/confirm`, { method: 'POST', token: checkerToken,
    key: `DBA-${randomUUID()}`, body: { version: paidSettlement.version,
      verificationReference: `DBA-${randomUUID()}`, note: 'Synthetic checker confirmation' } })).data;
  assert.equal(settled.status, 'SETTLED');
  await poll(() => db.inventory.jewelryItem.count({ where: { sourceSettlementId: settlement.id } }), (count) => count === 1);
  await poll(() => db.report.buybackSettlementFact.findUnique({ where: { settlementId: settlement.id } }), Boolean);
  const oldItem = await db.inventory.jewelryItem.findFirst({ where: { sourceSettlementId: settlement.id } });
  assert.equal(oldItem.status, 'PENDING_MELT');
  await request('/api/pos/orders', { method: 'POST', token, key: `DBA-${randomUUID()}`,
    body: { branchId: branch.id, tagCodes: [oldItem.tagCode] }, status: 409 });
  assert.equal((await db.inventory.jewelryItem.findUnique({ where: { id: oldItem.id } })).status, 'PENDING_MELT');
  mark('Buyback payment confirmation, one PENDING_MELT item and Report fact');

  if (buybackOnly) {
    stage = `Exchange ${exchangeCase} difference and fulfillment`;
    const warehouse = await db.inventory.warehouse.findUnique({ where: { branchId: branch.id } });
    const newItem = await db.inventory.jewelryItem.findFirst({ where: {
      warehouseId: warehouse.id, tagCode: { startsWith: 'DBA-' }, status: 'IN_STOCK', origin: 'STANDARD',
    }, orderBy: { createdAt: 'desc' } });
    assert.ok(newItem, 'Synthetic exchange item must be available');
    const exchangeWeight = { positive: '5.0000', negative: '11.0000', zero: '10.1100' }[exchangeCase];
    const expectedDirection = { positive: 'CUSTOMER_PAYS', negative: 'STORE_PAYS', zero: 'NONE' }[exchangeCase];
    const exchangeIntake = (await request(buybackPath, { method: 'POST', token, key: `DBA-${randomUUID()}`, status: 201,
      body: { customer: { name: 'DB acceptance exchange customer', phone: '0901234567' }, items: [{
        source: 'EXTERNAL', assetKind: 'GOLD', description: 'Synthetic old ring for exchange',
        condition: 'Used, intact', declaredWeight: exchangeWeight, initialMeasuredWeight: exchangeWeight,
      }] },
    })).data;
    const exchangePath = `${buybackPath}/${exchangeIntake.id}`;
    const submittedExchange = (await request(`${exchangePath}/submit`, { method: 'POST', token,
      body: { version: exchangeIntake.version } })).data;
    await request(`${exchangePath}/items/${exchangeIntake.items[0].id}/appraisal`, { method: 'PUT', token,
      key: `DBA-${randomUUID()}`, body: { version: submittedExchange.version, measuredWeight: exchangeWeight,
        acceptedWeight: exchangeWeight, metalId: metal.id, metalKind: 'GOLD', purityPerMille: '999.0000', condition: 'Used, intact' } });
    const exchangeAppraised = (await request(exchangePath, { token })).data;
    const exchangeQuote = (await request(`${exchangePath}/quotes`, { method: 'POST', token,
      key: `DBA-${randomUUID()}`, status: 201, body: { version: exchangeAppraised.version,
        items: [{ itemId: exchangeIntake.items[0].id, policyId: policy.id, policyVersion: policy.version }] } })).data;
    const exchangeQuoted = (await request(exchangePath, { token })).data;
    await request(`${exchangePath}/quotes/${exchangeQuote.id}/approve`, { method: 'POST', token: checkerToken,
      key: `DBA-${randomUUID()}`, body: { version: exchangeQuoted.version } });
    const exchangeApproved = (await request(exchangePath, { token })).data;
    const exchange = (await request(`${exchangePath}/exchanges`, { method: 'POST', token,
      key: `DBA-${randomUUID()}`, status: 201, body: {
        version: exchangeApproved.version, method: 'CASH', tagCode: newItem.tagCode,
      } })).data;
    assert.equal(exchange.status, 'AWAITING_PAYMENT');
    assert.equal(exchange.direction, expectedDirection);
    assert.equal(await db.inventory.exchangeHold.count({ where: { exchangeId: exchange.id, status: 'ACTIVE' } }), 1);
    const paidExchange = (await request(`${exchangePath}/settlements/${exchange.id}/payment`, { method: 'POST', token,
      key: `DBA-${randomUUID()}`, body: { version: exchange.version,
        reference: `DBA-${randomUUID()}`, evidence: 'Synthetic exchange receipt' } })).data;
    const confirmedExchange = (await request(`${exchangePath}/settlements/${exchange.id}/confirm`, {
      method: 'POST', token: checkerToken, key: `DBA-${randomUUID()}`, body: {
        version: paidExchange.version, verificationReference: `DBA-${randomUUID()}`,
        note: 'Synthetic exchange payment verified',
      } })).data;
    assert.equal(confirmedExchange.status, 'SETTLED');
    assert.equal((await db.inventory.jewelryItem.findUnique({ where: { id: newItem.id } })).status, 'SOLD');
    await poll(() => db.inventory.jewelryItem.count({ where: { sourceSettlementId: exchange.id } }), (count) => count === 1);
    await poll(() => db.report.buybackSettlementFact.findUnique({ where: { settlementId: exchange.id } }), Boolean);
    assert.equal(await db.sales.buybackSettlement.count({ where: { id: exchange.id, status: 'SETTLED' } }), 1);
    mark(`Exchange reserves and sells one new item, settles ${exchangeCase} difference, stocks old item once, reports once`);
  }

  console.log(`RESULT PASS ${passed} HTTP integration groups; synthetic IDs: branch=${branch.id}, buyback=${intake.id}${first ? `, POS=${first.id}, online=${online.id}` : ''}`);
} catch (error) {
  console.error(`FAIL at ${stage}; ${error.message}; passed=${passed}. Synthetic test data retained for diagnosis.`);
  process.exitCode = 1;
} finally {
  await Promise.all(Object.values(db).map((client) => client.$disconnect()));
}
