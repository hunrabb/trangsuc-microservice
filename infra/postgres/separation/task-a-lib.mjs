// Task A fixtures: all writes are limited to the labelled four-DB acceptance project.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertTestTarget } from './assert-test-target.mjs';

export const root = resolve(import.meta.dirname, '../../..');
process.loadEnvFile(resolve(root, '.env'));
export const key = () => `TA-${randomUUID()}`;
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const db = {};
const ports = { auth: 15433, inventory: 15434, sales: 15435, report: 15436 };
const names = { gateway: 'jewelry-db-separation-test-gateway-1', rabbitmq: 'jewelry-db-separation-test-rabbitmq-1', inventory: 'jewelry-db-separation-test-inventory-1' };
export function docker(args, timeout = 45_000) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.slice(-350)}`);
  return result.stdout;
}
export function inspect(name) { return JSON.parse(docker(['inspect', name]))[0]; }
export function guard({ broker = true } = {}) {
  for (const [service, port] of Object.entries(ports)) assertTestTarget(service, port);
  const gateway = inspect(names.gateway);
  assert.equal(gateway.Config.Labels['com.docker.compose.project'], 'jewelry-db-separation-test');
  assert.equal(gateway.Config.Labels['com.docker.compose.service'], 'gateway');
  assert.equal(gateway.State.Running, true);
  if (broker) {
    const rabbit = inspect(names.rabbitmq);
    assert.equal(rabbit.Config.Labels['com.docker.compose.project'], 'jewelry-db-separation-test');
    assert.equal(rabbit.Config.Labels['com.docker.compose.service'], 'rabbitmq');
    assert.equal(rabbit.State.Running, true);
  }
}
export function checkContainer(service) {
  const container = inspect(names[service]);
  assert.equal(container.Config.Labels['com.docker.compose.project'], 'jewelry-db-separation-test');
  assert.equal(container.Config.Labels['com.docker.compose.service'], service);
  return container;
}
export async function openDb() {
  guard();
  for (const [service, port] of Object.entries(ports)) {
    const url = new URL(`postgresql://${service}_user@127.0.0.1:${port}/${service}_db`);
    url.password = process.env[`${service.toUpperCase()}_DB_PASSWORD`];
    url.searchParams.set('schema', service);
    const require = createRequire(resolve(root, `apps/${service}/package.json`));
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { PrismaClient } = require('./dist/generated/prisma/client.js');
    db[service] = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href, max: 3 }, { schema: service }) });
    const [identity] = await db[service].$queryRawUnsafe('SELECT current_database() AS db, current_user AS role');
    assert.equal(identity.db, `${service}_db`);
    assert.equal(identity.role, `${service}_user`);
  }
}
export async function closeDb() { await Promise.all(Object.values(db).map((client) => client.$disconnect())); }
export async function poll(fn, check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (check(value)) return value;
    await pause(1200);
  }
  throw new Error('Timed out waiting for test state');
}
export async function http(path, { method = 'GET', actor, key: idempotencyKey, body, status = 200, timeout = 15_000 } = {}) {
  const response = await fetch(`http://127.0.0.1:13000${path}`, {
    method, headers: { accept: 'application/json', ...(actor ? { authorization: `Bearer ${actor.token}` } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (status !== null) assert.equal(response.status, status,
    `${method} ${path}: HTTP ${response.status}, expected ${status}; code=${data?.code ?? data?.error?.code ?? 'unknown'}`);
  return { status: response.status, data };
}
export async function actors() {
  guard();
  const authRequire = createRequire(resolve(root, 'apps/auth/package.json'));
  const { hash } = authRequire('bcryptjs');
  const password = randomBytes(24).toString('base64url');
  const email = `task-a-admin-${randomUUID()}@example.invalid`;
  const adminUser = await db.auth.user.create({ data: { email, fullName: 'Task A admin',
    passwordHash: await hash(password, 12), branches: { create: { role: 'ADMIN', branchId: null } } } });
  const login = await http('/api/auth/login', { method: 'POST', body: { email, password } });
  const admin = { id: adminUser.id, token: login.data.accessToken };
  const branchA = (await http('/api/admin/auth/branches', { method: 'POST', actor: admin, status: 201,
    body: { code: `TA-${randomUUID().slice(0, 8)}`, name: 'Task A branch' } })).data;
  const branchB = (await http('/api/admin/auth/branches', { method: 'POST', actor: admin, status: 201,
    body: { code: `TA-${randomUUID().slice(0, 8)}`, name: 'Task A other branch' } })).data;
  await poll(() => db.inventory.warehouse.findUnique({ where: { branchId: branchA.id } }), Boolean);
  await poll(() => db.inventory.warehouse.findUnique({ where: { branchId: branchB.id } }), Boolean);
  const { AccessTokenService } = authRequire('./dist/session/access-token.service.js');
  const { SessionService } = authRequire('./dist/session/session.service.js');
  const values = { JWT_PRIVATE_KEY_PATH: resolve(root, 'secrets/jwt/private.pem'),
    JWT_PUBLIC_KEY_PATH: resolve(root, 'secrets/jwt/public.pem'), JWT_ISSUER: process.env.JWT_ISSUER,
    JWT_AUDIENCE_BACKOFFICE: process.env.JWT_AUDIENCE_BACKOFFICE };
  const tokens = new AccessTokenService({ get: (name) => values[name] });
  tokens.onModuleInit();
  const sessions = new SessionService(db.auth, tokens);
  async function actor(role, branchId, label) {
    const user = await db.auth.user.create({ data: {
      email: `task-a-${label}-${randomUUID()}@example.invalid`, fullName: `Task A ${label}`,
      branches: { create: { role, branchId } },
    } });
    const opened = await sessions.open(user.id, { userAgent: 'Task A isolated acceptance' }, () => new Error('inactive fixture'));
    return { id: user.id, token: opened.session.accessToken };
  }
  return { admin, managerA: await actor('MANAGER', branchA.id, 'manager-a'),
    managerB: await actor('MANAGER', branchB.id, 'manager-b'),
    staffA: await actor('STAFF', branchA.id, 'staff-a'),
    staffB: await actor('STAFF', branchB.id, 'staff-b'), branchA, branchB };
}
export async function catalog(admin, branchId, itemCount = 3) {
  guard();
  const metal = (await http('/api/admin/inventory/metals', { method: 'POST', actor: admin, status: 201,
    body: { code: `TA-${randomUUID().slice(0, 8)}`, name: 'Task A gold', kind: 'GOLD' } })).data;
  await http(`/api/admin/inventory/metals/${metal.id}/prices`, { method: 'POST', actor: admin, status: 201,
    body: { buyPrice: '1000000.00', sellPrice: '2000000.00' } });
  const category = (await http('/api/admin/inventory/categories', { method: 'POST', actor: admin, status: 201,
    body: { name: `Task A category ${randomUUID()}` } })).data;
  const product = (await http('/api/admin/inventory/products', { method: 'POST', actor: admin, status: 201,
    body: { categoryId: category.id, name: 'Task A ring' } })).data;
  const variant = (await http('/api/admin/inventory/variants', { method: 'POST', actor: admin, status: 201,
    body: { productId: product.id, metalId: metal.id, sku: `TA-${randomUUID()}`,
      name: 'Task A size', defaultLaborFee: '100000.00' } })).data;
  const receipt = (await http('/api/admin/inventory/receipts', { method: 'POST', actor: admin, status: 201,
    body: { branchId } })).data;
  let latest = receipt;
  const tags = [];
  for (let i = 0; i < itemCount; i++) {
    const tagCode = `TA-${randomUUID()}`;
    tags.push(tagCode);
    latest = (await http(`/api/admin/inventory/receipts/${receipt.id}/lines`, { method: 'POST', actor: admin, status: 201,
      body: { variantId: variant.id, tagCode, weight: '5.0000', costPrice: '5000000.00' } })).data;
  }
  await http(`/api/admin/inventory/receipts/${receipt.id}/approve`, { method: 'POST', actor: admin,
    body: { version: latest.version } });
  assert.equal(await db.inventory.jewelryItem.count({ where: { tagCode: { in: tags }, status: 'IN_STOCK' } }), itemCount);
  return { metal, variant, tags };
}
export async function policy(admin, branchId, metalId) {
  return (await http(`/api/admin/sales/branches/${branchId}/buybacks/price-policies`, { method: 'POST',
    actor: admin, key: key(), status: 201, body: { metalId, metalKind: 'GOLD', purityPerMille: '999.0000',
      label: 'Task A gold policy', deductionVndPerItem: '10000.00', reason: 'Isolated Task A acceptance' } })).data;
}
export async function quotedBuyback({ branchId, maker, metalId, pricePolicy, count = 1 }) {
  guard();
  const path = `/api/admin/sales/branches/${branchId}/buybacks`;
  const weights = Array.from({ length: count }, (_, index) => `${index + 5}.0000`);
  const intake = (await http(path, { method: 'POST', actor: maker, key: key(), status: 201,
    body: { customer: { name: 'Task A seller', phone: '0901234567' }, items: weights.map((weight, index) => ({
      source: 'EXTERNAL', assetKind: 'GOLD', description: `Task A old ring ${index}`,
      condition: 'Used intact', declaredWeight: weight, initialMeasuredWeight: weight,
    })) } })).data;
  const itemPath = `${path}/${intake.id}`;
  const submitted = (await http(`${itemPath}/submit`, { method: 'POST', actor: maker,
    body: { version: intake.version } })).data;
  let version = submitted.version;
  for (let index = 0; index < count; index++) {
    await http(`${itemPath}/items/${intake.items[index].id}/appraisal`, { method: 'PUT', actor: maker,
      key: key(), body: { version, measuredWeight: weights[index], acceptedWeight: weights[index],
        metalId, metalKind: 'GOLD', purityPerMille: '999.0000', condition: 'Assayed, used intact' } });
    version = (await http(itemPath, { actor: maker })).data.version;
  }
  const quote = (await http(`${itemPath}/quotes`, { method: 'POST', actor: maker, key: key(), status: 201,
    body: { version, items: intake.items.map((item) => ({ itemId: item.id,
      policyId: pricePolicy.id, policyVersion: pricePolicy.version })) } })).data;
  const current = (await http(itemPath, { actor: maker })).data;
  return { intake, quote, version: current.version, path: itemPath, weights };
}
export async function approveBuyback(quoted, approver) {
  const approved = (await http(`${quoted.path}/quotes/${quoted.quote.id}/approve`, { method: 'POST',
    actor: approver, key: key(), body: { version: quoted.version } })).data;
  assert.equal(approved.status, 'APPROVED');
  return (await http(quoted.path, { actor: approver })).data;
}
export async function directSettlement(quoted, maker, approver, recorder = maker) {
  const approved = await approveBuyback(quoted, approver);
  const settlement = (await http(`${quoted.path}/settlements`, { method: 'POST', actor: maker,
    key: key(), status: 201, body: { version: approved.version, method: 'CASH' } })).data;
  const paid = (await http(`${quoted.path}/settlements/${settlement.id}/payment`, { method: 'POST',
    actor: recorder, key: key(), body: { version: settlement.version,
      reference: key(), evidence: 'Task A cash receipt and old gold handover' } })).data;
  const confirmed = (await http(`${quoted.path}/settlements/${settlement.id}/confirm`, { method: 'POST',
    actor: approver, key: key(), body: { version: paid.version,
      verificationReference: key(), note: 'Task A checker counted cash and received jewelry' } })).data;
  assert.equal(confirmed.status, 'SETTLED');
  return confirmed;
}
