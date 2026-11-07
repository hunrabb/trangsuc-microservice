// Chạy trên Postgres thật của Docker Compose: pnpm test:inventory. Gọi thẳng service của bản build inventory.
// Chỉ đụng vào dữ liệu do chính test tạo (mã bắt đầu bằng INVTEST-); chạy xong số dòng mọi bảng phải y như trước.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
process.loadEnvFile(resolve(REPO_ROOT, '.env'));

const password = process.env.INVENTORY_DB_PASSWORD;
const database = process.env.POSTGRES_DB;
if (!password || !database) {
  throw new Error('Thiếu INVENTORY_DB_PASSWORD hoặc POSTGRES_DB trong .env');
}
const DATABASE_URL = `postgresql://inventory_user:${password}@127.0.0.1:5432/${database}?schema=inventory`;
const PREFIX = 'INVTEST-';
const ROUNDS = 10;

const appRequire = createRequire(resolve(REPO_ROOT, 'apps/inventory/package.json'));
const { PrismaPg } = appRequire('@prisma/adapter-pg');
const { PrismaClient } = appRequire('./dist/generated/prisma/client.js');
const { ItemSalesService } = appRequire('./dist/stock/item-sales.service.js');

interface Db {
  $disconnect(): Promise<void>;
  [model: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface DeductResult {
  replayed: boolean;
  items: { tagCode: string; price: string; metalSellPricePerChi: string }[];
}

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }, { schema: 'inventory' }),
}) as Db;

const sales = new ItemSalesService(db) as {
  deductItemsForOrder(request: {
    orderId: string;
    branchId: string;
    tagCodes: string[];
  }): Promise<DeductResult>;
  releaseItemsForOrder(orderId: string): Promise<{ releasedTagCodes: string[] }>;
};

const TABLES = [
  'metal',
  'metalPrice',
  'category',
  'product',
  'productVariant',
  'warehouse',
  'jewelryItem',
  'stockMovement',
  'outboxEvent',
] as const;

const counts = async () =>
  Object.fromEntries(
    await Promise.all(TABLES.map(async (table) => [table, await db[table].count()])),
  );

describe('chống bán trùng một tem (deduct, release)', () => {
  let baseline: unknown;
  let metalId: string;
  let categoryId: string;
  let productId: string;
  let variantId: string;
  let warehouseId: string;
  const branchId = randomUUID();
  const orderIds: string[] = [];

  before(async () => {
    const migrated = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: resolve(REPO_ROOT, 'apps/inventory'),
      env: { ...process.env, DATABASE_URL },
      encoding: 'utf8',
    });
    if (migrated.status !== 0) {
      throw new Error(`prisma migrate deploy lỗi: ${migrated.stdout}${migrated.stderr}`);
    }
    const leftover = await db.metal.count({ where: { code: { startsWith: PREFIX } } });
    if (leftover > 0) {
      throw new Error('Dừng: còn dữ liệu INVTEST- của lần chạy trước, hãy dọn tay');
    }
    baseline = await counts();
    metalId = (
      await db.metal.create({
        data: { code: `${PREFIX}${randomUUID()}`, name: 'Vàng thử', kind: 'GOLD' },
      })
    ).id;
    await db.metalPrice.create({
      data: {
        metalId,
        buyPrice: '3400000',
        sellPrice: '3500000',
        effectiveFrom: new Date(Date.now() - 60_000),
        createdBy: randomUUID(),
      },
    });
    categoryId = (await db.category.create({ data: { name: `${PREFIX}${randomUUID()}` } })).id;
    productId = (await db.product.create({ data: { categoryId, name: 'Nhẫn thử' } })).id;
    variantId = (
      await db.productVariant.create({
        data: { productId, metalId, sku: `${PREFIX}${randomUUID()}`, name: 'Nhẫn thử' },
      })
    ).id;
    warehouseId = (await db.warehouse.create({ data: { branchId, name: 'Kho thử' } })).id;
  });

  after(async () => {
    try {
      await db.stockMovement.deleteMany({ where: { warehouseId } });
      await db.jewelryItem.deleteMany({ where: { warehouseId } });
      await db.outboxEvent.deleteMany({ where: { aggregateId: { in: orderIds } } });
      await db.warehouse.deleteMany({ where: { id: warehouseId } });
      await db.productVariant.deleteMany({ where: { id: variantId } });
      await db.product.deleteMany({ where: { id: productId } });
      await db.category.deleteMany({ where: { id: categoryId } });
      await db.metalPrice.deleteMany({ where: { metalId } });
      await db.metal.deleteMany({ where: { id: metalId } });
      assert.deepEqual(await counts(), baseline, 'dữ liệu phải giống hệt trước khi chạy');
    } finally {
      await db.$disconnect();
    }
  });

  const newOrderId = () => {
    const orderId = randomUUID();
    orderIds.push(orderId);
    return orderId;
  };

  /** Một chiếc đang `IN_STOCK` trong kho thử, trọng lượng 1,2345 chỉ, tiền công 150.000. */
  const newItemInStock = async () => {
    const tagCode = `${PREFIX}${randomUUID()}`;
    await db.jewelryItem.create({
      data: {
        tagCode,
        variantId,
        warehouseId,
        weight: '1.2345',
        laborFee: '150000',
        costPrice: '4000000',
      },
    });
    return tagCode;
  };

  const deduct = (orderId: string, tagCodes: string[]) =>
    sales.deductItemsForOrder({ orderId, branchId, tagCodes });

  const itemOf = (tagCode: string) => db.jewelryItem.findUnique({ where: { tagCode } });

  const movementsOf = (orderId: string, type: string) =>
    db.stockMovement.count({ where: { refType: 'Order', refId: orderId, type } });

  it(`hai đơn cùng mua một tem song song, ${ROUNDS} vòng: đúng một đơn thành công`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const tagCode = await newItemInStock();
      const [orderA, orderB] = [newOrderId(), newOrderId()];

      const results = await Promise.allSettled([
        deduct(orderA, [tagCode]),
        deduct(orderB, [tagCode]),
      ]);

      assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        1,
        `vòng ${round}`,
      );
      const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      const error = loser.reason as { code?: string; details?: { tagCodes?: string[] } };
      assert.equal(error.code, 'ITEM_NOT_AVAILABLE', `vòng ${round}`);
      assert.deepEqual(error.details?.tagCodes, [tagCode]);

      const winner = results[0]?.status === 'fulfilled' ? orderA : orderB;
      const item = await itemOf(tagCode);
      assert.equal(item.status, 'SOLD');
      assert.equal(item.orderId, winner);
      assert.equal((await movementsOf(orderA, 'SALE')) + (await movementsOf(orderB, 'SALE')), 1);
    }
  });

  it('một chiếc không bán được thì cả đơn hoàn tác (tất cả hoặc không có gì)', async () => {
    const available = await newItemInStock();
    const alreadySold = await newItemInStock();
    await deduct(newOrderId(), [alreadySold]);
    const orderId = newOrderId();

    await assert.rejects(
      deduct(orderId, [available, alreadySold]),
      (error: { code?: string }) => error.code === 'ITEM_NOT_AVAILABLE',
    );

    assert.equal((await itemOf(available)).status, 'IN_STOCK');
    assert.equal(await movementsOf(orderId, 'SALE'), 0);
  });

  it('deduct 2 lần cùng orderId (lần lượt và song song): hàng chỉ bị trừ một lần, kết quả như nhau', async () => {
    const tags = [await newItemInStock(), await newItemInStock()];
    const orderId = newOrderId();

    const first = await deduct(orderId, tags);
    const [second, third] = await Promise.all([deduct(orderId, tags), deduct(orderId, tags)]);

    assert.equal(first.replayed, false);
    assert.equal(second.replayed && third.replayed, true);
    assert.deepEqual(second.items, first.items, 'phải trả đúng giá đã chốt lần đầu');
    // 1,2345 × 3.500.000 + 150.000 = 4.470.750 → làm tròn tới 1.000 đồng
    assert.equal(first.items[0]?.price, '4471000.00');
    assert.equal(await movementsOf(orderId, 'SALE'), 2, 'sổ kho không ghi trùng');
    assert.equal(
      await db.outboxEvent.count({ where: { aggregateId: orderId } }),
      1,
      'chỉ phát một sự kiện',
    );
    for (const tagCode of tags) {
      assert.equal((await itemOf(tagCode)).version, 2, 'mỗi chiếc chỉ đổi trạng thái một lần');
    }
  });

  it('cùng orderId nhưng khác nội dung: 422 IDEMPOTENCY_KEY_REUSED, không đổi gì', async () => {
    const [first, second] = [await newItemInStock(), await newItemInStock()];
    const orderId = newOrderId();
    await deduct(orderId, [first]);

    await assert.rejects(
      deduct(orderId, [first, second]),
      (error: { code?: string }) => error.code === 'IDEMPOTENCY_KEY_REUSED',
    );
    assert.equal((await itemOf(second)).status, 'IN_STOCK');
  });

  it('release rồi chiếc đó bán lại được; release gọi lại không sao', async () => {
    const tagCode = await newItemInStock();
    const firstOrder = newOrderId();
    await deduct(firstOrder, [tagCode]);

    const released = await sales.releaseItemsForOrder(firstOrder);
    const releasedAgain = await sales.releaseItemsForOrder(firstOrder);

    assert.deepEqual(released.releasedTagCodes, [tagCode]);
    assert.deepEqual(releasedAgain.releasedTagCodes, []);
    const afterRelease = await itemOf(tagCode);
    assert.equal(afterRelease.status, 'IN_STOCK');
    assert.equal(afterRelease.orderId, null);
    assert.equal(await movementsOf(firstOrder, 'RELEASE'), 1, 'sổ kho không ghi trùng');

    const secondOrder = newOrderId();
    const resold = await deduct(secondOrder, [tagCode]);
    assert.equal(resold.replayed, false);
    assert.equal((await itemOf(tagCode)).orderId, secondOrder);

    // orderId đã giải phóng thì không dùng lại để trừ kho.
    await assert.rejects(
      deduct(firstOrder, [await newItemInStock()]),
      (error: { code?: string }) => error.code === 'INVALID_STATE',
    );
  });
});
