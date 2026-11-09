// Internal Inventory updates -> real transactional outbox -> broker -> Sales -> Gateway.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { requireAcknowledgement, databaseUrl, gatewayUrl, FIXTURE } from './test-environment.mjs';
requireAcknowledgement();
const req = createRequire(new URL('../../apps/inventory/package.json', import.meta.url));
const { PrismaPg } = req('@prisma/adapter-pg');
const { PrismaClient } = req('./dist/generated/prisma/client.js');
const { CatalogPublisher } = req('./dist/catalog/catalog-publisher.js');
const inventory = new PrismaClient({
  adapter: new PrismaPg(
    { connectionString: databaseUrl(process.env.PHASE6_TEST_INVENTORY_URL, 'inventory'), max: 2 },
    { schema: 'inventory' },
  ),
});
const publisher = new CatalogPublisher(inventory);
const base = gatewayUrl(process.env.PHASE6_TEST_GATEWAY_URL);
async function projected(check) {
  await publisher.publish(FIXTURE.product);
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const r = await fetch(`${base}/api/shop/products/${FIXTURE.product}`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await r.json();
    if (check(r.status, body)) return body;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Catalog projection timeout');
}
let item, price;
let successful = false;
try {
  price = await inventory.metalPrice.findFirstOrThrow({
    where: { metalId: FIXTURE.metal },
    orderBy: { effectiveFrom: 'desc' },
  });
  item = await inventory.jewelryItem.create({
    data: {
      variantId: FIXTURE.variant,
      warehouseId: FIXTURE.warehouse,
      tagCode: `PH6CAT-${randomUUID()}`,
      weight: '1.25',
      laborFee: '100000',
      costPrice: '1000000',
    },
  });
  await test('CAT-01: fresh stock is projected through outbox/broker into public API', async () => {
    const body = await projected(
      (status, b) => status === 200 && b.inStock && b.variants[0].estimatedPrice === '2600000.00',
    );
    assert.equal(body.variants[0].inStock, true);
  });
  await test('CAT-02: updated Inventory metal price reaches Catalog without client price calculation', async () => {
    await inventory.metalPrice.update({ where: { id: price.id }, data: { sellPrice: '2100000' } });
    await projected((status, b) => status === 200 && b.variants[0].estimatedPrice === '2725000.00');
  });
  await test('CAT-03: unpublish removes product, republish restores latest snapshot', async () => {
    await inventory.product.update({
      where: { id: FIXTURE.product },
      data: { publishedOnline: false },
    });
    await projected((status) => status === 404);
    await inventory.product.update({
      where: { id: FIXTURE.product },
      data: { publishedOnline: true },
    });
    await projected((status, b) => status === 200 && b.inStock);
  });
  await test('CAT-04: removal of remaining stock projects unavailable while paid physical item stays reserved', async () => {
    assert.equal(
      await inventory.stockReservationItem.count({ where: { jewelryItemId: item.id } }),
      0,
    );
    await inventory.jewelryItem.delete({ where: { id: item.id } });
    item = null;
    await projected((status, b) => status === 200 && !b.inStock);
    assert.equal(
      (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: FIXTURE.item } })).status,
      'RESERVED',
    );
  });
  successful = true;
} finally {
  if (successful) {
    await inventory.metalPrice.update({
      where: { id: price.id },
      data: { sellPrice: price.sellPrice },
    });
    await publisher.publish(FIXTURE.product);
  }
  // Retain state on failure for investigation. Never clear the fixture graph or broker.
  await inventory.$disconnect();
}
