// Hạ tầng test riêng: HTTP thật tới controller đã build, Postgres thật; không bật worker RabbitMQ.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { GlobalExceptionFilter, JwtAuthModule } from '@jewelry/common';
import {
  createTestKeys,
  signTestToken,
  TEST_AUDIENCE_BACKOFFICE,
  TEST_AUDIENCE_SHOP,
  TEST_ISSUER,
} from '@jewelry/test-utils';
import type { PrismaClient as SalesDatabase } from '../../../apps/sales/src/generated/prisma/client.ts';
import type { PrismaClient as InventoryDatabase } from '../../../apps/inventory/src/generated/prisma/client.ts';

const root = resolve(import.meta.dirname, '../../..');
process.loadEnvFile(resolve(root, '.env'));
export const PREFIX = 'POSTEST-';
const salesRequire = createRequire(resolve(root, 'apps/sales/package.json'));
const inventoryRequire = createRequire(resolve(root, 'apps/inventory/package.json'));
const commonRequire = createRequire(resolve(root, 'libs/common/package.json'));
const { Module } = salesRequire('@nestjs/common');
const { ConfigModule } = commonRequire('@nestjs/config');
const { NestFactory } = salesRequire('@nestjs/core');
const { PrismaPg } = salesRequire('@prisma/adapter-pg');
const { PrismaClient: SalesClient } = salesRequire('./dist/generated/prisma/client.js');
const { PrismaClient: InventoryClient } = inventoryRequire('./dist/generated/prisma/client.js');

/** Lấy mật khẩu từ môi trường như tests/inventory; không in URL chứa bí mật ra log. */
function databaseUrl(service: 'sales' | 'inventory'): string {
  const password = process.env[`${service.toUpperCase()}_DB_PASSWORD`];
  const database = process.env.POSTGRES_DB;
  if (!password || !database) throw new Error(`Thiếu cấu hình Postgres cho ${service}`);
  return `postgresql://${service}_user:${encodeURIComponent(password)}@127.0.0.1:5432/${database}?schema=${service}`;
}

export const salesDatabase = new SalesClient({
  adapter: new PrismaPg({ connectionString: databaseUrl('sales'), max: 10 }, { schema: 'sales' }),
}) as SalesDatabase;
export const inventoryDatabase = new InventoryClient({
  adapter: new PrismaPg(
    { connectionString: databaseUrl('inventory'), max: 10 },
    { schema: 'inventory' },
  ),
}) as InventoryDatabase;

interface HttpApplication {
  useGlobalFilters(...filters: unknown[]): void;
  use(
    handler: (
      request: { path: string },
      response: { status(code: number): { json(body: unknown): void } },
      next: () => void,
    ) => void,
  ): void;
  listen(port: number, host: string): Promise<void>;
  getHttpServer(): { address(): AddressInfo };
  close(): Promise<void>;
}

const applications: HttpApplication[] = [];
const keys = createTestKeys();
export const branchId = randomUUID();
export const actorId = randomUUID();
export const metalId = randomUUID();
const categoryId = randomUUID();
const productId = randomUUID();
const variantId = randomUUID();
const warehouseId = randomUUID();
export const usedKeys: string[] = [];
export const createdCustomerIds: string[] = [];
export const inventoryCalls: string[] = [];
export const faults = { releaseFailures: 0, deductFailures: 0 };
export let inventoryUrl: string;
export const salesUrls: string[] = [];
let baseline: unknown;
let nextInventoryCommitPause: { entered: () => void; resume: Promise<void> } | undefined;

/** Chặn đúng lần commit Inventory kế tiếp để kiểm tra timeout ở Sales khi transaction vẫn chạy. */
export function pauseNextInventoryCommit(): { entered: Promise<void>; resume: () => void } {
  let signalEntered!: () => void;
  let signalResume!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    signalResume = resolve;
  });
  nextInventoryCommitPause = { entered: signalEntered, resume };
  return { entered, resume: signalResume };
}

/** Chỉ thay điểm commit trong test; mọi truy vấn và transaction vẫn chạy bằng Prisma/Postgres thật. */
const pausingInventoryDatabase = new Proxy(inventoryDatabase, {
  get(target, property) {
    if (property !== '$transaction') return Reflect.get(target, property, target);
    return (work: (transaction: unknown) => Promise<unknown>) =>
      target.$transaction(
        async (transaction) => {
          const result = await work(transaction);
          const pause = nextInventoryCommitPause;
          if (pause !== undefined) {
            nextInventoryCommitPause = undefined;
            pause.entered();
            await pause.resume;
          }
          return result;
        },
        { timeout: 15_000 },
      );
  },
});

/** Đếm các bảng liên quan để chứng minh sau test không làm mất hay để thừa dữ liệu của người khác. */
async function counts() {
  return {
    sales: await Promise.all([
      salesDatabase.order.count(),
      salesDatabase.orderItem.count(),
      salesDatabase.orderStatusHistory.count(),
      salesDatabase.auditLog.count(),
      salesDatabase.outboxEvent.count(),
      salesDatabase.customer.count(),
    ]),
    inventory: await Promise.all([
      inventoryDatabase.metal.count(),
      inventoryDatabase.metalPrice.count(),
      inventoryDatabase.category.count(),
      inventoryDatabase.product.count(),
      inventoryDatabase.productVariant.count(),
      inventoryDatabase.warehouse.count(),
      inventoryDatabase.jewelryItem.count(),
      inventoryDatabase.stockMovement.count(),
      inventoryDatabase.stockOrderOperation.count(),
      inventoryDatabase.outboxEvent.count(),
    ]),
  };
}

/** Migrate deploy chỉ hai schema bằng user riêng; không tạo/sửa database ngoài phạm vi test. */
function migrate(service: 'sales' | 'inventory'): void {
  const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(root, `apps/${service}`),
    env: { ...process.env, DATABASE_URL: databaseUrl(service) },
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`Migration ${service} lỗi: ${result.stdout}${result.stderr}`);
}

/** Bind port 0, không tranh cổng dev hay cần dừng hệ thống Docker khi test. */
async function createApplication(module: unknown): Promise<HttpApplication> {
  const app = (await NestFactory.create(module, { logger: false })) as HttpApplication;
  applications.push(app);
  app.useGlobalFilters(new GlobalExceptionFilter());
  return app;
}

async function startListening(app: HttpApplication): Promise<string> {
  await app.listen(0, '127.0.0.1');
  return `http://127.0.0.1:${app.getHttpServer().address().port}`;
}

/** Inventory controller và service thật; middleware chỉ gây lỗi mạng có chủ đích cho ca retry. */
async function startInventory(): Promise<void> {
  const { InternalStockController } = inventoryRequire('./dist/stock/internal-stock.controller.js');
  const { ItemSalesService } = inventoryRequire('./dist/stock/item-sales.service.js');
  const { PrismaService } = inventoryRequire('./dist/prisma/prisma.service.js');
  class InventoryTestModule {}
  Module({
    controllers: [InternalStockController],
    providers: [{ provide: PrismaService, useValue: pausingInventoryDatabase }, ItemSalesService],
  })(InventoryTestModule);
  const app = await createApplication(InventoryTestModule);
  app.use((request, response, next) => {
    inventoryCalls.push(request.path);
    if (request.path.endsWith('/deduct') && faults.deductFailures > 0) {
      faults.deductFailures -= 1;
      response
        .status(503)
        .json({ code: 'SERVICE_UNAVAILABLE', message: 'Kho bận', correlationId: randomUUID() });
    } else if (request.path.endsWith('/release') && faults.releaseFailures > 0) {
      faults.releaseFailures -= 1;
      response
        .status(503)
        .json({ code: 'SERVICE_UNAVAILABLE', message: 'Kho bận', correlationId: randomUUID() });
    } else next();
  });
  inventoryUrl = await startListening(app);
}

/** Hai instance sales độc lập, cùng Postgres, cùng kho; JWT ký bằng khoá test riêng, không dùng secrets thật. */
async function startSales(): Promise<void> {
  const { PrismaService } = salesRequire('./dist/prisma/prisma.service.js');
  const { PosOrdersController } = salesRequire('./dist/pos/pos-orders.controller.js');
  const { PosCustomersController } = salesRequire('./dist/pos/pos-customers.controller.js');
  const { PosCustomersService } = salesRequire('./dist/pos/pos-customers.service.js');
  const { PosOrdersService } = salesRequire('./dist/pos/pos-orders.service.js');
  const { OrderStore } = salesRequire('./dist/core/order-store.js');
  const { InventoryStockClient } = salesRequire('./dist/pos/inventory-stock.client.js');
  class SalesTestModule {}
  Module({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            JWT_PUBLIC_KEY_PATH: keys.publicKeyPath,
            JWT_ISSUER: TEST_ISSUER,
            JWT_AUDIENCE_BACKOFFICE: TEST_AUDIENCE_BACKOFFICE,
            JWT_AUDIENCE_SHOP: TEST_AUDIENCE_SHOP,
            INVENTORY_URL: inventoryUrl,
          }),
        ],
      }),
      JwtAuthModule,
    ],
    controllers: [PosOrdersController, PosCustomersController],
    providers: [
      { provide: PrismaService, useValue: salesDatabase },
      OrderStore,
      InventoryStockClient,
      PosOrdersService,
      PosCustomersService,
    ],
  })(SalesTestModule);
  const app = await createApplication(SalesTestModule);
  salesUrls.push(await startListening(app));
}

/** Dừng nếu thấy dữ liệu cũ cùng tiền tố; không dọn hộ một lần test khác đang chạy. */
export async function setup(): Promise<void> {
  migrate('sales');
  migrate('inventory');
  if (
    (await salesDatabase.order.count({ where: { idempotencyKey: { startsWith: PREFIX } } })) ||
    (await inventoryDatabase.metal.count({ where: { code: { startsWith: PREFIX } } }))
  ) {
    throw new Error('Dừng: còn dữ liệu POSTEST- ngoài lần chạy này');
  }
  baseline = await counts();
  await inventoryDatabase.metal.create({
    data: { id: metalId, code: `${PREFIX}${randomUUID()}`, name: 'Vàng thử POS', kind: 'GOLD' },
  });
  await inventoryDatabase.metalPrice.create({
    data: {
      metalId,
      buyPrice: '3400000',
      sellPrice: '3500000',
      effectiveFrom: new Date(0),
      createdBy: actorId,
    },
  });
  await inventoryDatabase.category.create({
    data: { id: categoryId, name: `${PREFIX}${randomUUID()}` },
  });
  await inventoryDatabase.product.create({
    data: { id: productId, categoryId, name: 'Nhẫn thử POS' },
  });
  await inventoryDatabase.productVariant.create({
    data: { id: variantId, productId, metalId, sku: `${PREFIX}${randomUUID()}`, name: 'Nhẫn 18K' },
  });
  await inventoryDatabase.warehouse.create({
    data: { id: warehouseId, branchId, name: 'Kho thử POS' },
  });
  await startInventory();
  await startSales();
  await startSales();
}

/** Chỉ xoá theo UUID/key đã tạo bởi lần chạy này, rồi so sánh số dòng với mốc trước test. */
export async function cleanup(): Promise<void> {
  try {
    await Promise.all(applications.map((app) => app.close()));
    const orders = await salesDatabase.order.findMany({
      where: { idempotencyKey: { in: usedKeys } },
      select: { id: true },
    });
    const orderIds = orders.map((order) => order.id);
    await salesDatabase.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await salesDatabase.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
    await salesDatabase.auditLog.deleteMany({ where: { orderId: { in: orderIds } } });
    await salesDatabase.outboxEvent.deleteMany({ where: { aggregateId: { in: orderIds } } });
    await salesDatabase.order.deleteMany({ where: { id: { in: orderIds } } });
    await salesDatabase.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
    await inventoryDatabase.stockMovement.deleteMany({ where: { warehouseId } });
    await inventoryDatabase.stockOrderOperation.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await inventoryDatabase.jewelryItem.deleteMany({ where: { warehouseId } });
    await inventoryDatabase.outboxEvent.deleteMany({ where: { aggregateId: { in: orderIds } } });
    await inventoryDatabase.warehouse.deleteMany({ where: { id: warehouseId } });
    await inventoryDatabase.productVariant.deleteMany({ where: { id: variantId } });
    await inventoryDatabase.product.deleteMany({ where: { id: productId } });
    await inventoryDatabase.category.deleteMany({ where: { id: categoryId } });
    await inventoryDatabase.metalPrice.deleteMany({ where: { metalId } });
    await inventoryDatabase.metal.deleteMany({ where: { id: metalId } });
    if (baseline !== undefined)
      assert.deepEqual(await counts(), baseline, 'Dữ liệu sau test phải y như trước');
  } finally {
    await Promise.all([salesDatabase.$disconnect(), inventoryDatabase.$disconnect()]);
  }
}

export function newKey(): string {
  const key = `${PREFIX}${randomUUID()}`;
  usedKeys.push(key);
  return key;
}

/** Một tem riêng của test; giá cuối 1,2345 × 3.500.000 + 150.000 = 4.471.000 sau làm tròn. */
export async function newItem(): Promise<string> {
  const tagCode = `${PREFIX}${randomUUID()}`;
  await inventoryDatabase.jewelryItem.create({
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
}

export function tokenFor(role = 'STAFF', branch = branchId): Promise<string> {
  return signTestToken(keys.privateKey, {
    claims: { sub: actorId, branches: [{ branchId: branch, role }] },
  });
}

export async function post(
  path: string,
  body?: unknown,
  key?: string,
  instance = 0,
  token?: string,
) {
  const response = await fetch(`${salesUrls[instance]}/pos/orders${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token ?? (await tokenFor())}`,
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const createOrder = (tagCodes: string[], key = newKey(), instance = 0) =>
  post('', { branchId, tagCodes }, key, instance);
