import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Decimal } from '@prisma/client/runtime/client';
import { CatalogPublisher } from '../dist/catalog/catalog-publisher.js';

const id = '00000000-0000-4000-8000-000000000001';
const variantId = '00000000-0000-4000-8000-000000000002';
function fixture(
  overrides = {},
  items = [{ id, weight: new Decimal('1.25'), laborFee: new Decimal('100000') }],
  buffer = 0,
) {
  const events = [];
  const product = {
    id,
    categoryId: id,
    category: { name: 'Nhẫn', isActive: true },
    name: 'Nhẫn vàng',
    description: null,
    imageUrl: null,
    publishedOnline: true,
    isActive: true,
    catalogVersion: 2,
    variants: [
      {
        id: variantId,
        metalId: id,
        sku: 'N001',
        name: '18K',
        isActive: true,
        metal: { isActive: true, kind: 'GOLD' },
      },
    ],
    ...overrides,
  };
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ sellPrice: new Decimal('2000000') }],
    product: { update: async () => product },
    warehouse: {
      findMany: async (q) => {
        assert.deepEqual(q.where, { isActive: true, acceptsOnlineOrders: true });
        return [{ id }];
      },
    },
    onlineStockBuffer: { findUnique: async () => ({ quantity: buffer }) },
    jewelryItem: {
      findMany: async (q) => {
        assert.equal(q.where.status, 'IN_STOCK');
        assert.equal(q.take, 500);
        assert.deepEqual(Object.keys(q.select), ['id', 'weight', 'laborFee']);
        return items;
      },
    },
    outboxEvent: {
      create: async ({ data }) => {
        events.push(data);
      },
    },
  };
  return { events, publisher: new CatalogPublisher({ $transaction: async (cb) => cb(tx) }) };
}
test('published product: Inventory computes price, emits only public fields and online stock', async () => {
  const { events, publisher } = fixture();
  await publisher.publish(id);
  assert.equal(events.length, 2);
  assert.equal(events[0].eventType, 'stock.availability_changed');
  assert.equal(events[0].payload.available, 1);
  assert.equal(events[1].payload.variants[0].estimatedPrice, '2600000.00');
  assert.equal(events[1].payload.isActive, true);
  const body = JSON.stringify(events.map((e) => e.payload));
  for (const secret of [
    'costPrice',
    'buyPrice',
    'laborFee',
    'weight',
    'warehouseId',
    'tagCode',
    'createdBy',
  ])
    assert.equal(body.includes(secret), false);
});
test('unpublished/inactive product emits tombstone and zero availability', async () => {
  for (const overrides of [
    { publishedOnline: false },
    { isActive: false },
    { category: { name: 'Nhẫn', isActive: false } },
  ]) {
    const { events, publisher } = fixture(overrides);
    await publisher.publish(id);
    assert.equal(events[0].payload.available, 0);
    assert.equal(events[1].payload.isActive, false);
    assert.deepEqual(events[1].payload.variants, []);
  }
});
test('sold-out product or online buffer consumes all stock: never advertised as available', async () => {
  for (const [items, buffer] of [
    [[], 0],
    [[{ id, weight: new Decimal(1), laborFee: new Decimal(0) }], 1],
  ]) {
    const { events, publisher } = fixture({}, items, buffer);
    await publisher.publish(id);
    assert.equal(events[0].payload.available, 0);
    assert.equal(events[1].payload.variants[0].estimatedPrice, null);
  }
});
test('inactive variant is removed from public snapshot', async () => {
  const { events, publisher } = fixture({
    variants: [{ id: variantId, isActive: false, metal: { isActive: true } }],
  });
  await publisher.publish(id);
  assert.deepEqual(events[1].payload.variants, []);
  assert.equal(events[0].payload.available, 0);
});

test('publish/config controllers retain staff authentication and ADMIN-only writes', async () => {
  const { OnlineConfigController } = await import('../dist/catalog/online-config.controller.js');
  const { CatalogController } = await import('../dist/catalog/catalog.controller.js');
  assert.equal(Reflect.getMetadata('jewelry:isPublic', OnlineConfigController), undefined);
  assert.deepEqual(Reflect.getMetadata('jewelry:roles', OnlineConfigController), ['ADMIN']);
  assert.equal(Reflect.getMetadata('jewelry:isPublic', CatalogController), undefined);
  assert.deepEqual(
    Reflect.getMetadata('jewelry:roles', CatalogController.prototype.updateProduct),
    ['ADMIN'],
  );
});
test('online configuration validates targets and changes only warehouse/buffer fields', async () => {
  const { OnlineConfigController } = await import('../dist/catalog/online-config.controller.js');
  const writes = [];
  const controller = new OnlineConfigController({
    warehouse: {
      count: async () => 1,
      update: async (q) => {
        writes.push(q.data);
        return { id, ...q.data };
      },
    },
    productVariant: { count: async () => 1 },
    onlineStockBuffer: {
      upsert: async (q) => {
        writes.push(q.update);
        return q.create;
      },
    },
  });
  assert.equal(
    (await controller.warehouse(id, { acceptsOnlineOrders: true })).acceptsOnlineOrders,
    true,
  );
  assert.equal((await controller.buffer(id, variantId, { quantity: 2 })).quantity, 2);
  assert.deepEqual(writes, [{ acceptsOnlineOrders: true }, { quantity: 2 }]);
  const missing = new OnlineConfigController({
    warehouse: { count: async () => 0 },
    productVariant: { count: async () => 0 },
  });
  await assert.rejects(missing.warehouse(id, { acceptsOnlineOrders: true }), /Không có kho/);
  await assert.rejects(
    missing.buffer(id, variantId, { quantity: 0 }),
    /Không có kho hoặc biến thể/,
  );
});
