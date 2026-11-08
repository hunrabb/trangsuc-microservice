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
const ROUNDS = 5;
const ITEM_COUNT = 4;

const appRequire = createRequire(resolve(REPO_ROOT, 'apps/inventory/package.json'));
const { PrismaPg } = appRequire('@prisma/adapter-pg');
const { PrismaClient } = appRequire('./dist/generated/prisma/client.js');
const { StockCountService } = appRequire('./dist/stock-count/stock-count.service.js');

interface Db {
  $disconnect(): Promise<void>;
  [model: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface Actor {
  id: string;
  branches: { branchId: string | null; role: string }[];
}

interface Summary {
  id: string;
  status: string;
  expectedCount: number;
  scannedCount: number;
  missingCount: number;
  extraCount: number;
  missingTagCodes: string[];
  extraTagCodes: string[];
}

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }, { schema: 'inventory' }),
}) as Db;

const stockCounts = new StockCountService(db) as {
  createStockCount(user: Actor, request: { branchId: string }): Promise<Summary>;
  scanTag(user: Actor, id: string, request: { tagCode: string }): Promise<{ result: string }>;
  closeStockCount(user: Actor, id: string): Promise<Summary>;
};

const TABLES = [
  'metal',
  'category',
  'product',
  'productVariant',
  'warehouse',
  'jewelryItem',
  'stockMovement',
  'stockCount',
  'stockCountLine',
  'stockCountExtra',
  'auditLog',
] as const;

const counts = async () =>
  Object.fromEntries(
    await Promise.all(TABLES.map(async (table) => [table, await db[table].count()])),
  );

describe('kiểm kê kho', () => {
  let baseline: unknown;
  let metalId: string;
  let categoryId: string;
  let productId: string;
  let variantId: string;
  const branchId = randomUUID();
  const otherBranchId = randomUUID();
  let warehouseId: string;
  let otherWarehouseId: string;
  let itemTags: string[] = [];
  let foreignTag: string;
  const stockCountIds: string[] = [];

  const manager = (): Actor => ({ id: randomUUID(), branches: [{ branchId, role: 'MANAGER' }] });
  const staff = (): Actor => ({ id: randomUUID(), branches: [{ branchId, role: 'STAFF' }] });

  before(async () => {
    const migrated = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: resolve(REPO_ROOT, 'apps/inventory'),
      env: { ...process.env, DATABASE_URL },
      encoding: 'utf8',
    });
    if (migrated.status !== 0) {
      throw new Error(`prisma migrate deploy lỗi: ${migrated.stdout}${migrated.stderr}`);
    }
    if ((await db.metal.count({ where: { code: { startsWith: PREFIX } } })) > 0) {
      throw new Error('Dừng: còn dữ liệu INVTEST- của lần chạy trước, hãy dọn tay');
    }
    baseline = await counts();
    metalId = (
      await db.metal.create({
        data: { code: `${PREFIX}${randomUUID()}`, name: 'Vàng thử', kind: 'GOLD' },
      })
    ).id;
    categoryId = (await db.category.create({ data: { name: `${PREFIX}${randomUUID()}` } })).id;
    productId = (await db.product.create({ data: { categoryId, name: 'Nhẫn thử' } })).id;
    variantId = (
      await db.productVariant.create({
        data: { productId, metalId, sku: `${PREFIX}${randomUUID()}`, name: 'Nhẫn thử' },
      })
    ).id;
    warehouseId = (await db.warehouse.create({ data: { branchId, name: 'Kho thử' } })).id;
    otherWarehouseId = (
      await db.warehouse.create({ data: { branchId: otherBranchId, name: 'Kho khác' } })
    ).id;
    itemTags = await Promise.all(Array.from({ length: ITEM_COUNT }, () => createItem(warehouseId)));
    foreignTag = await createItem(otherWarehouseId);
  });

  after(async () => {
    try {
      const warehouses = { warehouseId: { in: [warehouseId, otherWarehouseId] } };
      await db.stockMovement.deleteMany({ where: warehouses });
      await db.stockCount.deleteMany({ where: { id: { in: stockCountIds } } }); // dòng và thừa xoá theo
      await db.auditLog.deleteMany({ where: { entityId: { in: stockCountIds } } });
      await db.jewelryItem.deleteMany({ where: warehouses });
      await db.warehouse.deleteMany({ where: { id: { in: [warehouseId, otherWarehouseId] } } });
      await db.productVariant.deleteMany({ where: { id: variantId } });
      await db.product.deleteMany({ where: { id: productId } });
      await db.category.deleteMany({ where: { id: categoryId } });
      await db.metal.deleteMany({ where: { id: metalId } });
      assert.deepEqual(await counts(), baseline, 'dữ liệu phải giống hệt trước khi chạy');
    } finally {
      await db.$disconnect();
    }
  });

  async function createItem(forWarehouseId: string): Promise<string> {
    const tagCode = `${PREFIX}${randomUUID()}`;
    await db.jewelryItem.create({
      data: {
        tagCode,
        variantId,
        warehouseId: forWarehouseId,
        weight: '1.0000',
        laborFee: '100000',
        costPrice: '3000000',
      },
    });
    return tagCode;
  }

  /** Mở phiên và nhớ id để dọn. */
  async function openSession(): Promise<Summary> {
    const summary = await stockCounts.createStockCount(manager(), { branchId });
    stockCountIds.push(summary.id);
    return summary;
  }

  const movementsOf = (stockCountId: string) =>
    db.stockMovement.count({
      where: { refType: 'StockCount', refId: stockCountId, type: 'COUNT_MISSING' },
    });

  const statusOf = async (tagCode: string) =>
    (await db.jewelryItem.findUnique({ where: { tagCode } })).status;

  it(`hai người đóng và hai người quét cùng phiên song song, ${ROUNDS} vòng: đúng một lần đóng, kết quả nhất quán`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const session = await openSession();
      assert.equal(session.expectedCount, ITEM_COUNT);

      const results = await Promise.allSettled([
        stockCounts.closeStockCount(manager(), session.id),
        stockCounts.closeStockCount(manager(), session.id),
        stockCounts.scanTag(staff(), session.id, { tagCode: itemTags[0] as string }),
        stockCounts.scanTag(staff(), session.id, { tagCode: itemTags[1] as string }),
      ]);

      const [closeA, closeB, ...scans] = results;
      const closes = [closeA, closeB];
      assert.equal(
        closes.filter((result) => result.status === 'fulfilled').length,
        1,
        `vòng ${round}`,
      );
      const failedClose = closes.find(
        (result) => result.status === 'rejected',
      ) as PromiseRejectedResult;
      assert.equal((failedClose.reason as { code?: string }).code, 'INVALID_STATE');
      for (const scan of scans) {
        if (scan.status === 'rejected') {
          assert.equal(
            (scan.reason as { code?: string }).code,
            'INVALID_STATE',
            'quét sau khi đóng',
          );
        }
      }

      // Bất biến: số chiếc đã quét thành công + số chiếc thiếu = số chiếc dự kiến; sổ kho khớp số thiếu.
      const scannedCount = scans.filter((scan) => scan.status === 'fulfilled').length;
      const finalSummary = await db.stockCount.findUnique({ where: { id: session.id } });
      assert.equal(finalSummary.status, 'CLOSED');
      assert.equal(
        await db.stockCountLine.count({ where: { stockCountId: session.id, status: 'SCANNED' } }),
        scannedCount,
      );
      assert.equal(
        await db.stockCountLine.count({ where: { stockCountId: session.id, status: 'EXPECTED' } }),
        0,
      );
      assert.equal(
        await db.stockCountLine.count({ where: { stockCountId: session.id, status: 'MISSING' } }),
        ITEM_COUNT - scannedCount,
      );
      assert.equal(await movementsOf(session.id), ITEM_COUNT - scannedCount, `vòng ${round}`);
    }
  });

  it('đóng phiên: chiếc không quét được thành MISSING kèm StockMovement; chiếc quét được không đổi', async () => {
    const session = await openSession();
    const [scannedA, scannedB, notScannedA, notScannedB] = itemTags as [
      string,
      string,
      string,
      string,
    ];
    await stockCounts.scanTag(staff(), session.id, { tagCode: scannedA });
    await stockCounts.scanTag(staff(), session.id, { tagCode: scannedB });

    const closed = await stockCounts.closeStockCount(manager(), session.id);

    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.expectedCount, ITEM_COUNT);
    assert.equal(closed.scannedCount, 2);
    assert.equal(closed.missingCount, 2);
    assert.deepEqual(closed.missingTagCodes, [notScannedA, notScannedB].sort());
    assert.equal(await movementsOf(session.id), 2);
    const movedTags = (
      await db.stockMovement.findMany({
        where: { refId: session.id, type: 'COUNT_MISSING' },
        include: { item: true },
      })
    ).map((movement: { item: { tagCode: string } }) => movement.item.tagCode);
    assert.deepEqual(movedTags.sort(), [notScannedA, notScannedB].sort());
    for (const tagCode of itemTags) {
      assert.equal(
        await statusOf(tagCode),
        'IN_STOCK',
        'phiên kiểm kê không đổi trạng thái chiếc nào',
      );
    }
    await assert.rejects(
      stockCounts.closeStockCount(manager(), session.id),
      (error: { code?: string }) => error.code === 'INVALID_STATE',
    );
  });

  it('quét mã không thuộc kho: vào danh sách thừa, không đổi chiếc, không thêm vào kho', async () => {
    const session = await openSession();
    const unknownTag = `${PREFIX}khong-co-${randomUUID()}`;
    const itemsBefore = await db.jewelryItem.count({ where: { warehouseId } });

    const foreignResult = await stockCounts.scanTag(staff(), session.id, { tagCode: foreignTag });
    const unknownResult = await stockCounts.scanTag(staff(), session.id, { tagCode: unknownTag });
    const repeatResult = await stockCounts.scanTag(staff(), session.id, { tagCode: foreignTag });

    assert.equal(foreignResult.result, 'EXTRA');
    assert.equal(unknownResult.result, 'EXTRA');
    assert.equal(repeatResult.result, 'EXTRA', 'quét lại vẫn thừa, không ghi trùng');
    const summary = (await stockCounts.closeStockCount(manager(), session.id)) as Summary;
    assert.equal(summary.extraCount, 2);
    assert.deepEqual(summary.extraTagCodes, [foreignTag, unknownTag].sort());
    const foreignItem = await db.jewelryItem.findUnique({ where: { tagCode: foreignTag } });
    assert.equal(foreignItem.warehouseId, otherWarehouseId);
    assert.equal(foreignItem.status, 'IN_STOCK');
    assert.equal(await db.jewelryItem.count({ where: { warehouseId } }), itemsBefore);
    assert.equal(await db.jewelryItem.count({ where: { tagCode: unknownTag } }), 0);
  });
});
