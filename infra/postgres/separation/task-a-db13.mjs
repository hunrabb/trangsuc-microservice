import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { actors, catalog, checkContainer, closeDb, db, directSettlement, docker, guard,
  inspect, openDb, pause, policy, poll, quotedBuyback, root } from './task-a-lib.mjs';

const inventoryName = 'jewelry-db-separation-test-inventory-1';
const brokerName = 'jewelry-db-separation-test-rabbitmq-1';
let inventoryStopped = false, brokerStopped = false, stage = 'preflight';
const pass = (name) => console.log(`PASS ${name}`);

async function stopInventory() {
  assert.equal(checkContainer('inventory').State.Running, true);
  docker(['stop', '-t', '10', inventoryName]);
  inventoryStopped = true;
  assert.equal(checkContainer('inventory').State.Running, false);
}
async function startInventory() {
  if (!inventoryStopped) return;
  docker(['start', inventoryName]);
  inventoryStopped = false;
  await poll(async () => {
    try { return (await fetch('http://127.0.0.1:13002/health/ready', { signal: AbortSignal.timeout(3000) })).status; }
    catch { return 0; }
  }, (status) => status === 200);
}
function broker() {
  const container = inspect(brokerName);
  assert.equal(container.Config.Labels['com.docker.compose.project'], 'jewelry-db-separation-test');
  assert.equal(container.Config.Labels['com.docker.compose.service'], 'rabbitmq');
  return container;
}
async function stopBroker() {
  assert.equal(broker().State.Running, true);
  docker(['stop', '-t', '10', brokerName]);
  brokerStopped = true;
  assert.equal(broker().State.Running, false);
}
async function startBroker() {
  if (!brokerStopped) return;
  docker(['start', brokerName]);
  brokerStopped = false;
  await poll(() => broker().State.Health?.Status, (status) => status === 'healthy');
}
async function replay(event) {
  const require = createRequire(resolve(root, 'libs/common/package.json'));
  const { connect } = require('amqplib');
  const url = new URL('amqp://127.0.0.1:15677');
  url.username = process.env.RABBITMQ_APP_USER;
  url.password = process.env.RABBITMQ_APP_PASSWORD;
  const model = await connect(url.href);
  try {
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
  } finally { await model.close(); }
}
async function stockEvidence(settlement, expectedItems) {
  const id = settlement.id;
  const rows = await db.inventory.$queryRaw`
    SELECT count(*)::int AS items, count(DISTINCT "tagCode")::int AS tags,
      count(DISTINCT "sourceQuoteLineId")::int AS quote_lines,
      count(DISTINCT "sourceIntakeItemId")::int AS intake_items,
      count(*) FILTER (WHERE status='PENDING_MELT' AND origin='BOUGHT_BACK')::int AS pending_melt,
      COALESCE(sum("costPrice"),0)::text AS cost
    FROM "inventory"."JewelryItem" WHERE "sourceSettlementId"=${id}::uuid`;
  const row = rows[0];
  assert.equal(row.items, expectedItems);
  assert.equal(row.tags, expectedItems);
  assert.equal(row.quote_lines, expectedItems);
  assert.equal(row.intake_items, expectedItems);
  assert.equal(row.pending_melt, expectedItems);
  assert.equal(Number(row.cost), Number(settlement.approvedAmount));
  assert.equal(await db.inventory.goodsReceipt.count({ where: { sourceSettlementId: id, status: 'APPROVED' } }), 1);
  assert.equal(await db.inventory.goodsReceiptLine.count({ where: { receiptId: id } }), expectedItems);
  assert.equal(await db.inventory.stockMovement.count({ where: { refType: 'BuybackSettlement', refId: id, type: 'BUYBACK' } }), expectedItems);
  assert.equal(await db.inventory.auditLog.count({ where: { entityId: id, action: 'buyback.received' } }), 1);
  assert.equal(await db.inventory.outboxEvent.count({ where: { aggregateId: id, eventType: 'buyback.stocked' } }), 1);
  assert.equal(await db.report.buybackSettlementFact.count({ where: { settlementId: id } }), 1);
  assert.equal(await db.report.buybackStockFact.count({ where: { settlementId: id } }), 1);
  assert.equal(await db.sales.buybackSettlementAudit.count({ where: { settlementId: id, action: 'PAYMENT_CONFIRMED' } }), 1);
  return row;
}

try {
  await openDb();
  const a = await actors();
  const stock = await catalog(a.admin, a.branchA.id, 1);
  const pricePolicy = await policy(a.admin, a.branchA.id, stock.metal.id);
  pass('DB-13 target guarded: four independent test DB roles, Gateway, broker and worker fixtures');

  stage = 'DB-13A/E: missing event and three-item recovery';
  guard();
  const quoted = await quotedBuyback({ branchId: a.branchA.id, maker: a.staffA,
    metalId: stock.metal.id, pricePolicy, count: 3 });
  await stopInventory();
  await stopBroker();
  guard({ broker: false });
  const settled = await directSettlement(quoted, a.staffA, a.managerA);
  assert.equal(await db.sales.buybackSettlement.count({ where: { id: settled.id, status: 'SETTLED' } }), 1);
  assert.equal(await db.inventory.jewelryItem.count({ where: { sourceSettlementId: settled.id } }), 0);
  const original = await db.sales.outboxEvent.findFirst({ where: { aggregateId: settled.id, eventType: 'buyback.settled' } });
  assert.ok(original);
  assert.notEqual(original.status, 'PUBLISHED');
  // Fault injection is limited to this newly created test settlement's event.
  assert.equal((await db.sales.outboxEvent.deleteMany({ where: { id: original.id, aggregateId: settled.id,
    eventType: 'buyback.settled', status: { not: 'PUBLISHED' } } })).count, 1);
  assert.equal(await db.sales.outboxEvent.count({ where: { aggregateId: settled.id, eventType: 'buyback.settled' } }), 0);
  const salesRequire = createRequire(resolve(root, 'apps/sales/package.json'));
  const { BuybackSettlementService } = salesRequire('./dist/buybacks/buyback-settlement.service.js');
  const { BuybackSettlementRecoveryWorker } = salesRequire('./dist/buybacks/buyback-settlement-recovery.worker.js');
  const { ExchangeClient } = salesRequire('./dist/buybacks/exchange-client.js');
  const svc = new BuybackSettlementService(db.sales, new ExchangeClient({ get: () => 'http://127.0.0.1:13002' }));
  const worker = new BuybackSettlementRecoveryWorker(db.sales, svc);
  await worker.scan();
  assert.equal(await db.sales.outboxEvent.count({ where: { aggregateId: settled.id, eventType: 'buyback.settled' } }), 1);
  pass(`DB-13A missing event recreated by real worker; settlement=${settled.id}`);
  await worker.scan();
  assert.equal(await db.sales.outboxEvent.count({ where: { aggregateId: settled.id, eventType: 'buyback.settled' } }), 1);
  pass('DB-13B worker scan rerun creates no second stock event');
  await startBroker();
  await startInventory();
  const restored = await poll(() => db.sales.outboxEvent.findFirst({ where: { aggregateId: settled.id,
    eventType: 'buyback.settled' } }), (event) => event?.status === 'PUBLISHED');
  await poll(() => db.inventory.jewelryItem.count({ where: { sourceSettlementId: settled.id } }), (count) => count === 3);
  await poll(() => db.report.buybackStockFact.findUnique({ where: { settlementId: settled.id } }), Boolean);
  const evidence = await stockEvidence(settled, 3);
  assert.equal(await db.inventory.processedEvent.count({ where: { eventId: restored.id } }), 1);
  assert.equal(await db.report.processedEvent.count({ where: { eventId: restored.id } }), 1);
  pass(`DB-13E three old-gold items, receipt lines, movements and unique provenance; cost=${evidence.cost}`);

  stage = 'DB-13C: lost ACK equivalent redelivery after Inventory commit';
  guard();
  await Promise.all([replay(restored), replay(restored)]);
  await pause(3000);
  await stockEvidence(settled, 3);
  assert.equal(await db.inventory.processedEvent.count({ where: { eventId: restored.id } }), 1);
  assert.equal(await db.report.processedEvent.count({ where: { eventId: restored.id } }), 1);
  pass('DB-13C duplicate redelivery after commit leaves one processed event and three items');

  stage = 'DB-13D: Inventory service unavailable then recovers';
  guard();
  const quotedOffline = await quotedBuyback({ branchId: a.branchA.id, maker: a.staffA,
    metalId: stock.metal.id, pricePolicy, count: 1 });
  await stopInventory();
  const offline = await directSettlement(quotedOffline, a.staffA, a.managerA);
  assert.equal(await db.sales.buybackSettlement.count({ where: { id: offline.id, status: 'SETTLED' } }), 1);
  assert.equal(await db.inventory.jewelryItem.count({ where: { sourceSettlementId: offline.id } }), 0);
  const pending = await poll(() => db.sales.outboxEvent.findFirst({ where: { aggregateId: offline.id,
    eventType: 'buyback.settled' } }), (event) => event?.status === 'PUBLISHED');
  assert.equal(await db.inventory.processedEvent.count({ where: { eventId: pending.id } }), 0);
  await startInventory();
  await poll(() => db.inventory.jewelryItem.count({ where: { sourceSettlementId: offline.id } }), (count) => count === 1);
  await poll(() => db.report.buybackStockFact.findUnique({ where: { settlementId: offline.id } }), Boolean);
  await stockEvidence(offline, 1);
  assert.equal(await db.inventory.processedEvent.count({ where: { eventId: pending.id } }), 1);
  pass(`DB-13D Inventory down: Sales stayed SETTLED, queued event delivered after restart; settlement=${offline.id}`);
  console.log('RESULT PASS DB-13A/B/C/D/E on isolated PostgreSQL and real service/worker');
} catch (error) {
  console.error(`FAIL ${stage}: ${error.message}; test data retained for diagnosis`);
  process.exitCode = 1;
} finally {
  try { await startBroker(); await startInventory(); }
  catch (error) { console.error(`RECOVERY FAILED: ${error.message}`); process.exitCode = 1; }
  await closeDb();
}
