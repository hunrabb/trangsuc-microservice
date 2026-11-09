import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { recordCancelledOrder } from '../dist/orders/order-report.handler.js';
test('unpaid WEBSITE cancellation never creates a POS revenue/tombstone row', async () => {
  let writes = 0;
  const tx = {
    orderRevenue: {
      createMany: async () => {
        writes++;
        throw new Error('must not touch POS report');
      },
    },
  };
  await recordCancelledOrder({ channel: 'WEBSITE', orderId: randomUUID() }, { tx });
  assert.equal(writes, 0);
});
