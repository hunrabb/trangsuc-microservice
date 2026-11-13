import assert from 'node:assert/strict';
import { actors, approveBuyback, catalog, closeDb, db, guard, http, key, openDb,
  policy, poll, quotedBuyback } from './task-a-lib.mjs';

let stage = 'preflight';
try {
  await openDb();
  guard();
  const a = await actors();
  const stock = await catalog(a.admin, a.branchA.id, 1);
  const pricePolicy = await policy(a.admin, a.branchA.id, stock.metal.id);
  const cases = [];
  for (let i = 0; i < 2; i++) {
    const quoted = await quotedBuyback({ branchId: a.branchA.id, maker: a.staffA,
      metalId: stock.metal.id, pricePolicy });
    const approved = await approveBuyback(quoted, a.managerA);
    cases.push({ quoted, approved });
  }
  stage = 'two concurrent exchange reserves on one physical tag';
  guard();
  const attempts = await Promise.all(cases.map(({ quoted, approved }) => http(`${quoted.path}/exchanges`, {
    method: 'POST', actor: a.staffA, key: key(), status: null,
    body: { version: approved.version, method: 'CASH', tagCode: stock.tags[0] },
  })));
  assert.deepEqual(attempts.map((item) => item.status).sort(), [201, 201]);
  const ids = attempts.map((item) => item.data.id);
  const rows = await poll(() => db.sales.buybackSettlement.findMany({ where: { id: { in: ids } } }),
    (items) => items.length === 2 && items.every((item) => ['AWAITING_PAYMENT', 'CANCELLED'].includes(item.status)));
  assert.deepEqual(rows.map((item) => item.status).sort(), ['AWAITING_PAYMENT', 'CANCELLED']);
  const winner = rows.find((item) => item.status === 'AWAITING_PAYMENT');
  assert.equal(await db.inventory.exchangeHold.count({ where: { tagCode: stock.tags[0], status: 'ACTIVE' } }), 1);
  assert.equal(await db.inventory.jewelryItem.count({ where: { tagCode: stock.tags[0], status: 'RESERVED' } }), 1);
  assert.equal(await db.sales.order.count({ where: { id: { in: ids } } }), 0);
  assert.equal(await db.report.orderRevenue.count({ where: { orderId: { in: ids } } }), 0);
  console.log(`PASS two concurrent exchange reserve requests: one active hold, one cancelled, no sale/revenue; winning settlement=${winner.id}`);
} catch (error) {
  console.error(`FAIL ${stage}: ${error.message}; test rows retained for SQL diagnosis`);
  process.exitCode = 1;
} finally { await closeDb(); }
