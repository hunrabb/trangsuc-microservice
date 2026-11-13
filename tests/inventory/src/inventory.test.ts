// Chạy trên Postgres thật của Docker Compose: pnpm test:inventory. Gọi thẳng các service của bản build inventory
// (không dựng HTTP): phần cần kiểm là transaction và tranh chấp khoá.
// Chỉ đụng vào dữ liệu do chính test tạo (mã bắt đầu bằng INVTEST-); chạy xong số dòng mọi bảng phải y như trước.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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

const appRequire = createRequire(resolve(REPO_ROOT, 'apps/inventory/package.json'));
const { PrismaPg } = appRequire('@prisma/adapter-pg');
const { PrismaClient } = appRequire('./dist/generated/prisma/client.js');
const { ReceiptsService } = appRequire('./dist/receipts/receipts.service.js');
const { onBranchCreated, onBranchUpdated } = appRequire('./dist/branch/branch-events.js');

// Kiểu tối thiểu cho client lấy từ bản build.
interface Db {
  $disconnect(): Promise<void>;
  $transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T>;
  [model: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }, { schema: 'inventory' }),
}) as Db;
const receipts = new ReceiptsService(db) as {
  approve(
    user: Actor,
    id: string,
    body: { version: number },
  ): Promise<{ status: string; version: number }>;
};

interface Actor {
  id: string;
  branches: { branchId: string | null; role: string }[];
}

const TABLES = [
  'metal',
  'category',
  'product',
  'productVariant',
  'warehouse',
  'jewelryItem',
  'goodsReceipt',
  'goodsReceiptLine',
  'stockMovement',
  'auditLog',
] as const;

const counts = async () =>
  Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await db[t].count()])));

describe('lõi inventory trên Postgres thật', () => {
  let baseline: unknown;
  let variantId: string;
  const warehouseIds: string[] = [];
  const branchIds: string[] = [];
  const receiptIds: string[] = [];
  let metalId: string;
  let productId: string;
  let categoryId: string;

  before(async () => {
    const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: resolve(REPO_ROOT, 'apps/inventory'),
      env: { ...process.env, DATABASE_URL },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`prisma migrate deploy lỗi: ${result.stdout}${result.stderr}`);
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
    categoryId = (await db.category.create({ data: { name: `${PREFIX}${randomUUID()}` } })).id;
    productId = (await db.product.create({ data: { categoryId, name: 'Nhẫn thử' } })).id;
    variantId = (
      await db.productVariant.create({
        data: { productId, metalId, sku: `${PREFIX}${randomUUID()}`, name: 'Nhẫn thử 18K' },
      })
    ).id;
  });

  after(async () => {
    try {
      const whereWh = { warehouseId: { in: warehouseIds } };
      await db.stockMovement.deleteMany({ where: whereWh });
      await db.jewelryItem.deleteMany({ where: whereWh });
      await db.goodsReceipt.deleteMany({ where: { id: { in: receiptIds } } }); // dòng phiếu xoá theo
      await db.auditLog.deleteMany({ where: { entityId: { in: receiptIds } } });
      await db.warehouse.deleteMany({
        where: { OR: [{ id: { in: warehouseIds } }, { branchId: { in: branchIds } }] },
      });
      await db.productVariant.deleteMany({ where: { id: variantId } });
      await db.product.deleteMany({ where: { id: productId } });
      await db.category.deleteMany({ where: { id: categoryId } });
      await db.metal.deleteMany({ where: { id: metalId } });
      assert.deepEqual(await counts(), baseline, 'dữ liệu phải giống hệt trước khi chạy');
    } finally {
      await db.$disconnect();
    }
  });

  const admin = (): Actor => ({
    id: randomUUID(),
    branches: [{ branchId: null, role: 'ADMIN' }],
  });

  /** Kho của một chi nhánh mới, và một phiếu nháp có `lineCount` dòng. */
  async function draftReceipt(lineCount: number) {
    const branchId = randomUUID();
    branchIds.push(branchId);
    const warehouse = await db.warehouse.create({ data: { branchId, name: 'Kho thử' } });
    warehouseIds.push(warehouse.id);
    const receipt = await db.goodsReceipt.create({
      data: {
        code: `${PREFIX}${randomUUID()}`,
        warehouseId: warehouse.id,
        createdBy: randomUUID(),
        lines: {
          create: Array.from({ length: lineCount }, (_, index) => ({
            variantId,
            tagCode: `${PREFIX}${randomUUID()}-${index}`,
            weight: '1.2345',
            laborFee: '150000',
            costPrice: '4000000',
          })),
        },
      },
    });
    receiptIds.push(receipt.id);
    return { branchId, warehouse, receipt };
  }

  const stockOf = async (warehouseId: string, receiptId: string) => ({
    items: await db.jewelryItem.count({ where: { warehouseId, status: 'IN_STOCK' } }),
    movements: await db.stockMovement.count({ where: { warehouseId, refId: receiptId } }),
    audits: await db.auditLog.count({
      where: { entityId: receiptId, action: 'goods_receipt.approved' },
    }),
  });

  it(`hai người duyệt cùng một phiếu, ${ROUNDS} vòng: đúng một lần tạo hàng`, async (context) => {
    const losers: Record<string, number> = {};
    for (let round = 0; round < ROUNDS; round += 1) {
      const { warehouse, receipt } = await draftReceipt(5);

      const results = await Promise.allSettled([
        receipts.approve(admin(), receipt.id, { version: receipt.version }),
        receipts.approve(admin(), receipt.id, { version: receipt.version }),
      ]);

      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, `vòng ${round}`);
      const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      const code = String((loser.reason as { code?: unknown }).code);
      losers[code] = (losers[code] ?? 0) + 1;
      assert.ok(['INVALID_STATE', 'VERSION_CONFLICT'].includes(code), `mã lỗi ${code}`);
      assert.deepEqual(
        await stockOf(warehouse.id, receipt.id),
        { items: 5, movements: 5, audits: 1 },
        `vòng ${round}`,
      );
    }
    context.diagnostic(`bên thua: ${JSON.stringify(losers)}`);
  });

  it('duyệt sai version: 409 VERSION_CONFLICT, phiếu vẫn là nháp, không tạo hàng', async () => {
    const { warehouse, receipt } = await draftReceipt(2);

    await assert.rejects(
      receipts.approve(admin(), receipt.id, { version: receipt.version + 1 }),
      (error: { code?: string; httpStatus?: number }) =>
        error.code === 'VERSION_CONFLICT' && error.httpStatus === 409,
    );

    assert.equal((await db.goodsReceipt.findUnique({ where: { id: receipt.id } })).status, 'DRAFT');
    assert.deepEqual(await stockOf(warehouse.id, receipt.id), {
      items: 0,
      movements: 0,
      audits: 0,
    });
  });

  it('branch.created gửi 2 lần (trùng, và song song): đúng 1 kho; branch.updated tới trước vẫn đúng', async () => {
    const branchId = randomUUID();
    branchIds.push(branchId);
    const payload = { branchId, code: `${PREFIX}CN`, name: 'Chi nhánh thử' };
    const created = () => db.$transaction((tx: unknown) => onBranchCreated(payload, { tx }));

    await Promise.all([created(), created()]);
    await created();

    assert.equal(await db.warehouse.count({ where: { branchId } }), 1);

    // branch.updated đổi tên và ngừng hoạt động; branch.created đến SAU không được ghi đè lại.
    await db.$transaction((tx: unknown) =>
      onBranchUpdated({ ...payload, name: 'Tên mới', isActive: false }, { tx }),
    );
    await created();
    const warehouse = await db.warehouse.findUnique({ where: { branchId } });
    assert.equal(warehouse.name, 'Tên mới');
    assert.equal(warehouse.isActive, false);

    // branch.updated đến TRƯỚC branch.created của một chi nhánh khác: vẫn tạo đúng một kho.
    const other = randomUUID();
    branchIds.push(other);
    const otherPayload = { branchId: other, code: `${PREFIX}CN2`, name: 'Chi nhánh 2' };
    await db.$transaction((tx: unknown) =>
      onBranchUpdated({ ...otherPayload, isActive: true }, { tx }),
    );
    await db.$transaction((tx: unknown) => onBranchCreated(otherPayload, { tx }));
    assert.equal(await db.warehouse.count({ where: { branchId: other } }), 1);
  });
});
