import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { posOrderSchema, posOrderEventPayloadSchema } from '@jewelry/contracts';
import {
  actorId,
  branchId,
  cleanup,
  createOrder,
  faults,
  inventoryCalls,
  inventoryDatabase,
  inventoryUrl,
  newItem,
  newKey,
  post,
  salesDatabase,
  salesUrls,
  setup,
  tokenFor,
} from './support.ts';

describe('POS trên Postgres thật, hai instance sales và inventory HTTP thật', () => {
  before(setup);
  after(cleanup);

  it('hai quầy tranh một tem, 10 vòng: một thắng, một CANCELLED không có dòng bán', async () => {
    for (let round = 0; round < 10; round += 1) {
      const tagCode = await newItem();
      const keys = [newKey(), newKey()];
      const results = await Promise.all([
        createOrder([tagCode], keys[0], 0),
        createOrder([tagCode], keys[1], 1),
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), [201, 409], `vòng ${round}`);
      const success = results.find((result) => result.status === 201)!;
      const failure = results.find((result) => result.status === 409)!;
      assert.equal(failure.body.code, 'ITEM_NOT_AVAILABLE');
      assert.deepEqual(failure.body.details.tagCodes, [tagCode]);
      const orders = await salesDatabase.order.findMany({
        where: { idempotencyKey: { in: keys } },
        include: { items: true },
      });
      const cancelled = orders.find((order) => order.status === 'CANCELLED')!;
      assert.equal(cancelled.items.length, 0);
      assert.equal(cancelled.total.toFixed(2), '0.00');
      const item = await inventoryDatabase.jewelryItem.findUniqueOrThrow({ where: { tagCode } });
      assert.equal(item.status, 'SOLD');
      assert.equal(item.orderId, success.body.id);
      assert.equal(
        await inventoryDatabase.stockMovement.count({
          where: { jewelryItemId: item.id, type: 'SALE' },
        }),
        1,
      );
    }
  });

  it('cùng key gửi song song: cùng id, một hoá đơn, một bộ dòng và một order.created', async () => {
    const tags = [await newItem(), await newItem()];
    const key = newKey();
    const [first, second] = await Promise.all([
      createOrder(tags, key, 0),
      createOrder([...tags].reverse(), key, 1),
    ]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.deepEqual(first.body, second.body);
    const order = posOrderSchema.parse(first.body);
    assert.equal(order.status, 'PENDING_PAYMENT');
    assert.equal(order.total, '8942000.00');
    assert.equal(order.items[0]?.productName, 'Nhẫn thử POS');
    assert.equal(await salesDatabase.order.count({ where: { idempotencyKey: key } }), 1);
    assert.equal(await salesDatabase.orderItem.count({ where: { orderId: order.id } }), 2);
    const events = await salesDatabase.outboxEvent.findMany({ where: { aggregateId: order.id } });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, 'order.created');
    assert.equal(posOrderEventPayloadSchema.parse(events[0]?.payload).channel, 'POS');
    assert.equal((await createOrder([tags[0]!], key)).status, 422);
    assert.equal((await createOrder(tags, key)).body.total, order.total);
  });

  it('hai confirm-payment song song: đúng một thành công, một lịch sử và một order.paid', async () => {
    const created = await createOrder([await newItem()]);
    const id = created.body.id as string;
    const responses = await Promise.all([
      post(`/${id}/confirm-payment`),
      post(`/${id}/confirm-payment`, undefined, undefined, 1),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.equal(responses.find((response) => response.status === 409)?.body.code, 'INVALID_STATE');
    assert.equal(
      (await salesDatabase.order.findUniqueOrThrow({ where: { id } })).status,
      'COMPLETED',
    );
    assert.equal(
      await salesDatabase.orderStatusHistory.count({
        where: { orderId: id, toStatus: 'COMPLETED' },
      }),
      1,
    );
    assert.equal(
      await salesDatabase.outboxEvent.count({
        where: { aggregateId: id, eventType: 'order.paid' },
      }),
      1,
    );
  });

  it('huỷ sau xác nhận tiền: 409 và không có HTTP release, chiếc vẫn SOLD', async () => {
    const tagCode = await newItem();
    const created = await createOrder([tagCode]);
    const id = created.body.id as string;
    assert.equal((await post(`/${id}/confirm-payment`)).status, 200);
    const callsBefore = inventoryCalls.length;
    const cancelled = await post(`/${id}/cancel`);
    assert.equal(cancelled.status, 409);
    assert.equal(cancelled.body.code, 'INVALID_STATE');
    assert.equal(inventoryCalls.length, callsBefore);
    assert.equal(
      (await inventoryDatabase.jewelryItem.findUniqueOrThrow({ where: { tagCode } })).status,
      'SOLD',
    );
    assert.equal(
      await salesDatabase.outboxEvent.count({
        where: { aggregateId: id, eventType: 'order.cancelled' },
      }),
      0,
    );
  });

  it('confirm-payment đua cancel: bên thua không được trả kho của đơn đã thu tiền', async () => {
    for (let round = 0; round < 3; round += 1) {
      const tagCode = await newItem();
      const created = await createOrder([tagCode]);
      const id = created.body.id as string;
      const [paid, cancelled] = await Promise.all([
        post(`/${id}/confirm-payment`),
        post(`/${id}/cancel`, undefined, undefined, 1),
      ]);
      assert.deepEqual([paid.status, cancelled.status].sort(), [200, 409]);
      const item = await inventoryDatabase.jewelryItem.findUniqueOrThrow({ where: { tagCode } });
      assert.equal(item.status, paid.status === 200 ? 'SOLD' : 'IN_STOCK');
      const eventCount = await salesDatabase.outboxEvent.count({
        where: { aggregateId: id, eventType: { in: ['order.paid', 'order.cancelled'] } },
      });
      assert.equal(eventCount, 1);
    }
  });

  it('release hết retry: giữ CANCELLING, chặn confirm và request sau tiếp tục trả kho đúng một lần', async () => {
    const tagCode = await newItem();
    const created = await createOrder([tagCode]);
    const id = created.body.id as string;
    faults.releaseFailures = 3;
    assert.equal((await post(`/${id}/cancel`)).status, 503);
    assert.equal(
      (await salesDatabase.order.findUniqueOrThrow({ where: { id } })).status,
      'CANCELLING',
    );
    assert.equal((await post(`/${id}/confirm-payment`)).status, 409);
    assert.equal((await post(`/${id}/cancel`, undefined, undefined, 1)).status, 200);
    assert.equal(
      (await inventoryDatabase.jewelryItem.findUniqueOrThrow({ where: { tagCode } })).status,
      'IN_STOCK',
    );
    assert.equal(await salesDatabase.auditLog.count({ where: { orderId: id } }), 1);
    assert.equal(
      await salesDatabase.outboxEvent.count({
        where: { aggregateId: id, eventType: 'order.cancelled' },
      }),
      1,
    );
    assert.equal((await post(`/${id}/cancel`)).status, 409);
  });

  it('tiếp quản sau crash giữa deduct và lưu đơn: replay deduct, không quote lại rồi trả nhầm hàng', async () => {
    const tagCode = await newItem();
    const key = newKey();
    const id = randomUUID();
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ branchId, tagCodes: [tagCode] }))
      .digest('hex');
    await salesDatabase.order.create({
      data: {
        id,
        code: `POS-${randomUUID()}`,
        branchId,
        idempotencyKey: key,
        requestHash,
        requestedTagCodes: [tagCode],
        createdBy: actorId,
        deductionStarted: true,
        operationOwner: randomUUID(),
        operationUntil: new Date(0),
        history: { create: { toStatus: 'CREATING', changedBy: actorId } },
      },
    });
    const deducted = await fetch(`${inventoryUrl}/internal/stock/deduct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: id, branchId, tagCodes: [tagCode] }),
    });
    assert.equal(deducted.status, 200);
    const recovered = await createOrder([tagCode], key, 1);
    assert.equal(recovered.status, 201);
    assert.equal(recovered.body.id, id);
    assert.equal(recovered.body.status, 'PENDING_PAYMENT');
    assert.equal(
      (await inventoryDatabase.jewelryItem.findUniqueOrThrow({ where: { tagCode } })).status,
      'SOLD',
    );
    assert.equal(await salesDatabase.orderItem.count({ where: { orderId: id } }), 1);
  });

  it('không token, sai chi nhánh hay tự gửi giá: bị chặn trước khi ghi hoặc gọi kho', async () => {
    const tagCode = await newItem();
    const request = { branchId, tagCodes: [tagCode] };
    const callsBefore = inventoryCalls.length;
    assert.equal((await fetch(`${salesUrls[0]}/pos/orders`, { method: 'POST' })).status, 401);
    const foreign = await tokenFor('STAFF', randomUUID());
    assert.equal((await post('', request, newKey(), 0, foreign)).status, 403);
    assert.equal((await post('', { ...request, total: '1' }, newKey())).status, 400);
    assert.equal((await post('', request)).status, 400);
    assert.equal(inventoryCalls.length, callsBefore);
    const manager = await tokenFor('MANAGER');
    const created = await post('', request, newKey(), 0, manager);
    assert.equal(created.status, 201);
    assert.equal(
      (await post(`/${created.body.id}/confirm-payment`, undefined, undefined, 1, foreign)).status,
      403,
    );
    assert.equal(
      (await post(`/${created.body.id}/cancel`, undefined, undefined, 1, foreign)).status,
      403,
    );
  });
});
