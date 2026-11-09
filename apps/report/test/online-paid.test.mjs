import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { dispatchPaidOrder } from '../dist/orders/paid-order-dispatch.js';
test('online verified receipt is acknowledged without entering POS revenue before shipping/completion', async () => {
  let touches = 0;
  const tx = new Proxy(
    {},
    {
      get() {
        touches++;
        throw new Error('POS report must not be touched');
      },
    },
  );
  await dispatchPaidOrder(
    {
      channel: 'WEBSITE',
      orderId: randomUUID(),
      paymentId: randomUUID(),
      reservationId: randomUUID(),
      amount: '1000.00',
      currency: 'VND',
      receivedAt: new Date().toISOString(),
    },
    { tx },
  );
  assert.equal(touches, 0);
});
