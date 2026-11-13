// Prove Auth outbox retention and Inventory delivery across a test-broker outage.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertTestTarget } from './assert-test-target.mjs';

const root = resolve(import.meta.dirname, '../../..');
process.loadEnvFile(resolve(root, '.env'));
const brokerName = 'jewelry-db-separation-test-rabbitmq-1';
const run = (args, timeout = 30_000) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.slice(-300)}`);
  return result.stdout;
};
const inspect = (name) => JSON.parse(run(['inspect', name]))[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function replayEvent(event) {
  const require = createRequire(resolve(root, 'libs/common/package.json'));
  const { connect } = require('amqplib');
  const brokerUrl = new URL('amqp://127.0.0.1:15677');
  brokerUrl.username = process.env.RABBITMQ_APP_USER;
  brokerUrl.password = process.env.RABBITMQ_APP_PASSWORD;
  const connection = await connect(brokerUrl.href);
  try {
    const channel = await connection.createConfirmChannel();
    let returned = 0;
    channel.on('return', () => returned++);
    channel.publish('domain.events', event.eventType, Buffer.from(JSON.stringify({
      eventId: event.id, eventType: event.eventType,
      occurredAt: event.createdAt.toISOString(),
      correlationId: event.correlationId, payload: event.payload,
    })), { persistent: true, mandatory: true, messageId: event.id,
      headers: { 'x-correlation-id': event.correlationId,
        'x-original-routing-key': event.eventType } });
    await channel.waitForConfirms();
    assert.equal(returned, 0, `replay ${event.eventType} must route`);
    await channel.close();
  } finally { await connection.close(); }
}
async function poll(fn, check, ms = 90_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (check(value)) return value;
    await sleep(1500);
  }
  throw new Error('Timed out waiting for broker recovery');
}
const clients = {};
for (const [service, port] of [['auth', 15433], ['inventory', 15434], ['sales', 15435], ['report', 15436]]) {
  assertTestTarget(service, port);
  const url = new URL(`postgresql://${service}_user@127.0.0.1:${port}/${service}_db`);
  url.password = process.env[`${service.toUpperCase()}_DB_PASSWORD`];
  url.searchParams.set('schema', service);
  const require = createRequire(resolve(root, `apps/${service}/package.json`));
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('./dist/generated/prisma/client.js');
  clients[service] = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href, max: 2 }, { schema: service }) });
}
const broker = inspect(brokerName);
assert.equal(broker.Config.Labels['com.docker.compose.project'], 'jewelry-db-separation-test');
assert.equal(broker.Config.Labels['com.docker.compose.service'], 'rabbitmq');
assert.equal(broker.State.Running, true);
assert.equal(inspect('jewelry-db-separation-test-gateway-1').Config.Labels['com.docker.compose.project'], 'jewelry-db-separation-test');

let stopped = false;
let branchId;
try {
  const require = createRequire(resolve(root, 'apps/auth/package.json'));
  const { hash } = require('bcryptjs');
  const email = `dbaccept-broker-${randomUUID()}@example.invalid`;
  const password = randomBytes(24).toString('base64url');
  await clients.auth.user.create({ data: { email, fullName: 'DB broker acceptance admin',
    passwordHash: await hash(password, 12), branches: { create: { role: 'ADMIN', branchId: null } } } });
  const login = await fetch('http://127.0.0.1:13000/api/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10_000) });
  assert.equal(login.status, 200);
  const token = (await login.json()).accessToken;
  run(['stop', '-t', '10', brokerName], 40_000);
  stopped = true;
  assert.equal(inspect(brokerName).State.Running, false);
  const code = `DBA-BROKER-${randomUUID().slice(0, 8)}`;
  const created = await fetch('http://127.0.0.1:13000/api/admin/auth/branches', { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'DB broker outage branch' }), signal: AbortSignal.timeout(15_000) });
  assert.equal(created.status, 201, `branch HTTP ${created.status} while broker stopped`);
  branchId = (await created.json()).id;
  assert.ok(await clients.auth.branch.findUnique({ where: { id: branchId } }));
  const event = await clients.auth.outboxEvent.findFirst({ where: { aggregateId: branchId, eventType: 'branch.created' } });
  assert.ok(event, 'Auth outbox event must be persisted');
  assert.notEqual(event.status, 'PUBLISHED');
  assert.equal(await clients.inventory.warehouse.count({ where: { branchId } }), 0);
  console.log('PASS broker down: Auth branch committed, outbox retained, Inventory unchanged');
} finally {
  if (stopped) {
    run(['start', brokerName], 45_000);
    await poll(() => inspect(brokerName).State.Health?.Status, (status) => status === 'healthy');
    console.log('PASS test RabbitMQ restarted and healthy');
  }
  if (branchId) {
    const delivered = await poll(async () => ({
      outbox: await clients.auth.outboxEvent.findFirst({ where: { aggregateId: branchId, eventType: 'branch.created' } }),
      warehouse: await clients.inventory.warehouse.findUnique({ where: { branchId } }),
    }), (value) => value.outbox?.status === 'PUBLISHED' && !!value.warehouse);
    assert.equal(await clients.inventory.warehouse.count({ where: { branchId } }), 1);
    assert.equal(await clients.inventory.processedEvent.count({ where: { eventId: delivered.outbox.id } }), 1);
    console.log(`PASS broker recovery: outbox published and Inventory consumed exactly once; branch=${branchId}`);
    await replayEvent(delivered.outbox);
    await sleep(2500);
    assert.equal(await clients.inventory.warehouse.count({ where: { branchId } }), 1);
    assert.equal(await clients.inventory.processedEvent.count({ where: { eventId: delivered.outbox.id } }), 1);
    console.log('PASS exact event replay: Inventory warehouse and processed-event cardinality remain one');
    const buyback = await clients.sales.outboxEvent.findFirst({
      where: { eventType: 'buyback.settled', status: 'PUBLISHED' }, orderBy: { createdAt: 'desc' },
    });
    assert.ok(buyback, 'test buyback.settled event must exist');
    const beforeItems = await clients.inventory.jewelryItem.count({ where: { sourceSettlementId: buyback.aggregateId } });
    assert.ok(beforeItems > 0);
    assert.equal(await clients.report.buybackSettlementFact.count({ where: { settlementId: buyback.aggregateId } }), 1);
    await replayEvent(buyback);
    await sleep(2500);
    assert.equal(await clients.inventory.jewelryItem.count({ where: { sourceSettlementId: buyback.aggregateId } }), beforeItems);
    assert.equal(await clients.report.buybackSettlementFact.count({ where: { settlementId: buyback.aggregateId } }), 1);
    assert.equal(await clients.inventory.processedEvent.count({ where: { eventId: buyback.id } }), 1);
    assert.equal(await clients.report.processedEvent.count({ where: { eventId: buyback.id } }), 1);
    console.log('PASS buyback.settled replay: Inventory items and Report fact remain unique');
  }
  await Promise.all(Object.values(clients).map((client) => client.$disconnect()));
}
