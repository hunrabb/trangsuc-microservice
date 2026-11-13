import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { actors, catalog, closeDb, db, guard, http, key, openDb, pause, policy, poll,
  quotedBuyback, root } from './task-a-lib.mjs';

let stage = 'preflight';
const pass = (text) => console.log(`PASS ${text}`);
const raw = (path, options) => http(path, { ...options, status: null });
const statuses = (results) => results.map((result) => result.status).sort((a, b) => a - b);
const contains = (actual, expected) => assert.deepEqual(actual, expected);

async function replayTwice(event) {
  const require = createRequire(resolve(root, 'libs/common/package.json'));
  const { connect } = require('amqplib');
  const url = new URL('amqp://127.0.0.1:15677');
  url.username = process.env.RABBITMQ_APP_USER;
  url.password = process.env.RABBITMQ_APP_PASSWORD;
  const model = await connect(url.href);
  try {
    const publish = async () => {
      const channel = await model.createConfirmChannel();
      let returned = 0;
      channel.on('return', () => returned++);
      channel.publish('domain.events', event.eventType, Buffer.from(JSON.stringify({
        eventId: event.id, eventType: event.eventType, occurredAt: event.createdAt.toISOString(),
        correlationId: event.correlationId, payload: event.payload,
      })), { persistent: true, mandatory: true, messageId: event.id,
        headers: { 'x-correlation-id': event.correlationId,
          'x-original-routing-key': event.eventType } });
      await channel.waitForConfirms();
      assert.equal(returned, 0);
      await channel.close();
    };
    await Promise.all([publish(), publish()]);
  } finally { await model.close(); }
}

try {
  await openDb();
  const a = await actors();
  const stock = await catalog(a.admin, a.branchA.id, 2);
  const pricePolicy = await policy(a.admin, a.branchA.id, stock.metal.id);
  pass('Task A isolated DBs, real Gateway, Auth-issued JWT actors and fresh stock');

  stage = 'RBAC and quote approval race';
  guard();
  const q = await quotedBuyback({ branchId: a.branchA.id, maker: a.managerA,
    metalId: stock.metal.id, pricePolicy });
  await http(q.path, { status: 401 });
  await http(q.path, { actor: a.staffB, status: 403 });
  await http(q.path, { actor: a.managerB, status: 403 });
  await http(q.path, { actor: a.staffA });
  await http(q.path, { actor: a.admin });
  await http(`${q.path}/quotes/${q.quote.id}/approve`, { method: 'POST', actor: a.managerA,
    key: key(), status: 403, body: { version: q.version } });
  await http(`${q.path}/quotes/${q.quote.id}/approve`, { method: 'POST', actor: a.staffA,
    key: key(), status: 403, body: { version: q.version } });
  await http(`${q.path}/quotes/${q.quote.id}/approve`, { method: 'POST', actor: a.managerB,
    key: key(), status: 403, body: { version: q.version } });
  await http(`/api/admin/sales/branches/${a.branchA.id}/buybacks/price-policies`, {
    method: 'POST', actor: a.staffA, key: key(), status: 403,
    body: { metalId: stock.metal.id, metalKind: 'GOLD', purityPerMille: '999.0000',
      label: 'Forbidden', deductionVndPerItem: '0.00', reason: 'Task A policy denial' } });
  const approvalPath = `${q.path}/quotes/${q.quote.id}/approve`;
  const approvals = await Promise.all([raw(approvalPath, { method: 'POST', actor: a.admin, key: key(),
    body: { version: q.version } }), raw(approvalPath, { method: 'POST', actor: a.admin, key: key(),
    body: { version: q.version } })]);
  contains(statuses(approvals), [200, 409]);
  assert.equal(await db.sales.buybackQuote.count({ where: { id: q.quote.id, status: 'APPROVED' } }), 1);
  assert.equal(await db.sales.buybackIntakeAudit.count({ where: { intakeId: q.intake.id, action: 'APPROVED' } }), 1);
  pass('RBAC role/branch/unauthenticated and two simultaneous quote approvals: one approved');

  stage = 'RBAC spoofing and terminal locks';
  const path = `/api/admin/sales/branches/${a.branchA.id}/buybacks`;
  await http(path, { method: 'POST', actor: a.staffB, key: key(), status: 403,
    body: { customer: { name: 'Forbidden', phone: '0901234567' }, items: [{
      source: 'EXTERNAL', assetKind: 'GOLD', description: 'Forbidden', condition: 'Used', declaredWeight: '5.0000' }] } });
  await http(path, { method: 'POST', actor: a.staffA, key: key(), status: 400,
    body: { userId: a.admin.id, customer: { name: 'Spoof', phone: '0901234567' }, items: [{
      source: 'EXTERNAL', assetKind: 'GOLD', description: 'Spoof', condition: 'Used', declaredWeight: '5.0000' }] } });
  await http(path, { method: 'POST', actor: a.staffA, key: key(), status: 403,
    body: { branchId: a.branchB.id, customer: { name: 'Spoof', phone: '0901234567' }, items: [{
      source: 'EXTERNAL', assetKind: 'GOLD', description: 'Spoof', condition: 'Used', declaredWeight: '5.0000' }] } });
  const approvedIntake = (await http(q.path, { actor: a.admin })).data;
  await http(q.path, { method: 'PUT', actor: a.admin, status: 409,
    body: { version: approvedIntake.version, customer: { name: 'Locked', phone: '0901234567' },
      items: [{ source: 'EXTERNAL', assetKind: 'GOLD', description: 'Locked', condition: 'Used',
        declaredWeight: '5.0000' }] } });
  pass('RBAC prevents other-branch writes, userId/branchId spoofing and APPROVED intake edit');

  stage = 'Concurrent settlement creation and payment confirmation';
  guard();
  const settlementPath = `${q.path}/settlements`;
  const creates = await Promise.all([raw(settlementPath, { method: 'POST', actor: a.staffA, key: key(),
    body: { version: approvedIntake.version, method: 'CASH' } }), raw(settlementPath, {
    method: 'POST', actor: a.staffA, key: key(), body: { version: approvedIntake.version, method: 'CASH' } })]);
  contains(statuses(creates), [201, 409]);
  const settlement = creates.find((result) => result.status === 201).data;
  assert.equal(await db.sales.buybackSettlement.count({ where: { intakeId: q.intake.id, status: { not: 'CANCELLED' } } }), 1);
  assert.equal(await db.sales.buybackSettlementAudit.count({ where: { settlementId: settlement.id, action: 'CREATED' } }), 1);
  pass('Two simultaneous settlement requests: one live settlement and one creation audit');

  await http(`${settlementPath}/${settlement.id}/confirm`, { method: 'POST', actor: a.staffA,
    key: key(), status: 403, body: { version: settlement.version,
      verificationReference: key(), note: 'Staff cannot confirm settlement' } });
  await http(`${settlementPath}/${settlement.id}/confirm`, { method: 'POST', actor: a.managerB,
    key: key(), status: 403, body: { version: settlement.version,
      verificationReference: key(), note: 'Other branch cannot confirm settlement' } });
  const recorded = (await http(`${settlementPath}/${settlement.id}/payment`, { method: 'POST',
    actor: a.staffA, key: key(), body: { version: settlement.version,
      reference: key(), evidence: 'Task A physical cash receipt' } })).data;
  await http(`${settlementPath}/${settlement.id}/confirm`, { method: 'POST', actor: a.staffA,
    key: key(), status: 403, body: { version: recorded.version,
      verificationReference: key(), note: 'Maker cannot check own payment' } });
  const confirmationPath = `${settlementPath}/${settlement.id}/confirm`;
  const confirmations = await Promise.all([raw(confirmationPath, { method: 'POST', actor: a.managerA,
    key: key(), body: { version: recorded.version, verificationReference: key(),
      note: 'Manager checked payment and handover' } }), raw(confirmationPath, { method: 'POST',
    actor: a.admin, key: key(), body: { version: recorded.version, verificationReference: key(),
      note: 'Admin checked payment and handover' } })]);
  contains(statuses(confirmations), [200, 409]);
  assert.equal(await db.sales.buybackSettlement.count({ where: { id: settlement.id, status: 'SETTLED' } }), 1);
  assert.equal(await db.sales.buybackSettlementAudit.count({ where: { settlementId: settlement.id, action: 'PAYMENT_CONFIRMED' } }), 1);
  assert.equal(await db.sales.outboxEvent.count({ where: { aggregateId: settlement.id, eventType: 'buyback.settled' } }), 1);
  await http(q.path, { method: 'PUT', actor: a.admin, status: 409,
    body: { version: approvedIntake.version, customer: { name: 'Locked', phone: '0901234567' },
      items: [{ source: 'EXTERNAL', assetKind: 'GOLD', description: 'Locked', condition: 'Used',
        declaredWeight: '5.0000' }] } });
  pass('Two simultaneous payment confirmations: one SETTLED/audit/event; STAFF and wrong branch denied');

  stage = 'POS same-tag race and payment race';
  guard();
  const posBody = { branchId: a.branchA.id, tagCodes: [stock.tags[0]] };
  const orders = await Promise.all([raw('/api/pos/orders', { method: 'POST', actor: a.staffA,
    key: key(), body: posBody }), raw('/api/pos/orders', { method: 'POST', actor: a.staffA,
    key: key(), body: posBody })]);
  contains(statuses(orders), [201, 409]);
  const order = orders.find((result) => result.status === 201).data;
  assert.equal(await db.sales.order.count({ where: { id: order.id } }), 1);
  assert.equal(await db.inventory.jewelryItem.count({ where: { tagCode: stock.tags[0], status: 'SOLD', orderId: order.id } }), 1);
  const payments = await Promise.all([raw(`/api/pos/orders/${order.id}/confirm-payment`, {
    method: 'POST', actor: a.staffA }), raw(`/api/pos/orders/${order.id}/confirm-payment`, {
    method: 'POST', actor: a.staffA })]);
  contains(statuses(payments), [200, 409]);
  assert.equal(await db.sales.order.count({ where: { id: order.id, status: 'COMPLETED' } }), 1);
  assert.equal(await db.sales.outboxEvent.count({ where: { aggregateId: order.id, eventType: 'order.paid' } }), 1);
  await poll(() => db.report.orderRevenue.count({ where: { orderId: order.id } }), (count) => count === 1);
  pass('Two simultaneous same-tag POS and payment requests: one sale, one paid event, one revenue fact');

  stage = 'Concurrent duplicate worker delivery';
  guard();
  const event = await poll(() => db.sales.outboxEvent.findFirst({ where: {
    aggregateId: settlement.id, eventType: 'buyback.settled', status: 'PUBLISHED' } }), Boolean);
  await poll(() => db.inventory.jewelryItem.count({ where: { sourceSettlementId: settlement.id } }), (count) => count === 1);
  await poll(() => db.report.buybackSettlementFact.count({ where: { settlementId: settlement.id } }), (count) => count === 1);
  await replayTwice(event);
  await pause(3000);
  assert.equal(await db.inventory.jewelryItem.count({ where: { sourceSettlementId: settlement.id } }), 1);
  assert.equal(await db.inventory.processedEvent.count({ where: { eventId: event.id } }), 1);
  assert.equal(await db.report.buybackSettlementFact.count({ where: { settlementId: settlement.id } }), 1);
  assert.equal(await db.report.processedEvent.count({ where: { eventId: event.id } }), 1);
  pass('Two simultaneous duplicate RabbitMQ deliveries: one old-gold item and one Report fact');
  console.log(`RESULT PASS Task A concurrency/RBAC; IDs intake=${q.intake.id}, settlement=${settlement.id}, POS=${order.id}`);
} catch (error) {
  console.error(`FAIL ${stage}: ${error.message}; test rows retained for SQL diagnosis`);
  process.exitCode = 1;
} finally { await closeDb(); }
