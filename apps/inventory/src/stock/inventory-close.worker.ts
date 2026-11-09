import { randomUUID } from 'node:crypto';
import { outbox } from '@jewelry/common';
import { type InventorySnapshotClosedPayload, ROUTING_KEYS } from '@jewelry/contracts';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type SnapshotRow = InventorySnapshotClosedPayload['rows'][number];

/** Ngày và giờ chốt luôn dùng múi giờ Việt Nam, không dùng timezone của máy. */
export function closeDate(now: Date): string | null {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (name: string) => parts.find((part) => part.type === name)?.value ?? '';
  if (value('hour') !== '00' || Number(value('minute')) < 5 || Number(value('minute')) >= 60) {
    return null;
  }
  const today = `${value('year')}-${value('month')}-${value('day')}`;
  return new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** Chụp kho và sổ biến động trong cùng khoá ngắn; các instance tranh nhau bằng advisory lock. */
@Injectable()
export class InventoryCloseWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(InventoryCloseWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.runDue(), 60_000);
    this.timer.unref();
    void this.runDue();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Thử lại mỗi phút trong giờ chốt; sau giờ đó không giả lập snapshot của ngày đã lỡ. */
  async runDue(now = new Date()): Promise<void> {
    const localDate = closeDate(now);
    if (localDate === null || this.running) return;
    this.running = true;
    try {
      const warehouses = await this.prisma.warehouse.findMany({
        where: { isActive: true },
        select: { id: true, branchId: true },
      });
      for (const warehouse of warehouses) {
        try {
          await this.closeWarehouse(localDate, warehouse.id, warehouse.branchId);
        } catch (error) {
          this.logger.error(
            `Không chốt được kho ${warehouse.id}; sẽ thử lại trong phút sau`,
            error,
          );
        }
      }
    } catch (error) {
      this.logger.error('Không đọc được danh sách kho để chốt ngày', error);
    } finally {
      this.running = false;
    }
  }

  /** Unique ngày/kho và advisory lock bảo vệ cả retry lẫn nhiều Sales/Inventory instance. */
  async closeWarehouse(localDate: string, warehouseId: string, branchId: string): Promise<boolean> {
    return this.prisma.$transaction(
      async (transaction) => {
        const lock = await transaction.$queryRaw<[{ acquired: boolean }]>(Prisma.sql`
        SELECT pg_try_advisory_xact_lock(hashtext('inventory.daily.close'),
          hashtext(${localDate + warehouseId})) AS acquired`);
        if (!lock[0]?.acquired) return false;
        const existing = await transaction.inventoryDailyClose.findUnique({
          where: { localDate_warehouseId: { localDate, warehouseId } },
          select: { id: true },
        });
        if (existing) return false;

        // Mọi thay đổi tồn thực tế ghi StockMovement cùng transaction. Khoá SHARE chờ giao dịch đang ghi xong,
        // rồi chặn ghi mới trong lúc đọc hai nguồn; lock_timeout ngắn để quầy bán không bị đợi lâu.
        await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '150ms'");
        await transaction.$executeRawUnsafe('LOCK TABLE "inventory"."StockMovement" IN SHARE MODE');
        await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
        const captured = await transaction.$queryRaw<[{ capturedAt: Date }]>(Prisma.sql`
        SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS "capturedAt"`);
        const capturedAt = captured[0]!.capturedAt;
        const previousDate = new Date(Date.parse(`${localDate}T00:00:00Z`) - 86_400_000)
          .toISOString()
          .slice(0, 10);
        const previous = await transaction.inventoryDailyClose.findUnique({
          where: { localDate_warehouseId: { localDate: previousDate, warehouseId } },
          select: { capturedAt: true },
        });
        const rows = await this.snapshotRows(
          transaction,
          warehouseId,
          previous?.capturedAt ?? null,
          capturedAt,
        );
        const payload: InventorySnapshotClosedPayload = {
          closeId: randomUUID(),
          localDate,
          warehouseId,
          branchId,
          capturedAt: capturedAt.toISOString(),
          previousCapturedAt: previous?.capturedAt.toISOString() ?? null,
          rows,
        };
        await transaction.inventoryDailyClose.create({
          data: {
            id: payload.closeId,
            localDate,
            warehouseId,
            branchId,
            capturedAt,
            payload: payload as Prisma.InputJsonValue,
          },
        });
        await outbox.add(transaction, {
          eventType: ROUTING_KEYS.INVENTORY_SNAPSHOT_CLOSED,
          aggregateType: 'InventoryDailyClose',
          aggregateId: payload.closeId,
          payload,
        });
        // createdAt của movement được làm tròn mili-giây; giữ khoá qua ranh giới cutoff để không lọt dòng.
        await transaction.$executeRaw(Prisma.sql`SELECT pg_sleep(0.003)`);
        return true;
      },
      { timeout: 10_000 },
    );
  }

  /** Gom số chiếc, chỉ và giá vốn theo biến thể; COUNT_MISSING là quan sát kiểm kê, không phải xuất kho. */
  private async snapshotRows(
    transaction: Prisma.TransactionClient,
    warehouseId: string,
    previousCapturedAt: Date | null,
    capturedAt: Date,
  ): Promise<SnapshotRow[]> {
    return transaction.$queryRaw<SnapshotRow[]>(Prisma.sql`
      WITH current_stock AS (
        SELECT "variantId", COUNT(*)::integer AS "onHand",
          COALESCE(SUM("weight"), 0)::text AS "weight",
          COALESCE(SUM("costPrice"), 0)::text AS "value"
        FROM "inventory"."JewelryItem"
        WHERE "warehouseId" = ${warehouseId}::uuid AND "status" IN ('IN_STOCK', 'RESERVED')
        GROUP BY "variantId"
      ), changes AS (
        SELECT item."variantId",
          COUNT(*) FILTER (WHERE movement."type" = 'RECEIPT')::integer AS "received",
          COALESCE(SUM(item."weight") FILTER (WHERE movement."type" = 'RECEIPT'), 0)::text AS "receivedWeight",
          COALESCE(SUM(item."costPrice") FILTER (WHERE movement."type" = 'RECEIPT'), 0)::text AS "receivedValue",
          COUNT(*) FILTER (WHERE movement."type" = 'RELEASE')::integer AS "released",
          COALESCE(SUM(item."weight") FILTER (WHERE movement."type" = 'RELEASE'), 0)::text AS "releasedWeight",
          COALESCE(SUM(item."costPrice") FILTER (WHERE movement."type" = 'RELEASE'), 0)::text AS "releasedValue",
          COUNT(*) FILTER (WHERE movement."type" = 'SALE')::integer AS "sold",
          COALESCE(SUM(item."weight") FILTER (WHERE movement."type" = 'SALE'), 0)::text AS "soldWeight",
          COALESCE(SUM(item."costPrice") FILTER (WHERE movement."type" = 'SALE'), 0)::text AS "soldValue"
        FROM "inventory"."StockMovement" movement
        JOIN "inventory"."JewelryItem" item ON item."id" = movement."jewelryItemId"
        WHERE movement."warehouseId" = ${warehouseId}::uuid
          AND ${previousCapturedAt}::timestamptz IS NOT NULL
          AND movement."createdAt" > ${previousCapturedAt}::timestamptz
          AND movement."createdAt" <= ${capturedAt}::timestamptz
          AND movement."type" IN ('RECEIPT', 'RELEASE', 'SALE')
        GROUP BY item."variantId"
      ), variants AS (
        SELECT "variantId" FROM current_stock UNION SELECT "variantId" FROM changes
      )
      SELECT variant."id" AS "variantId", variant."sku", metal."id" AS "metalId",
        metal."code" AS "metalCode", metal."kind"::text AS "metalKind",
        COALESCE(stock."onHand", 0) AS "onHand",
        COALESCE(stock."weight", '0') AS "weight", COALESCE(stock."value", '0') AS "value",
        COALESCE(changes."received", 0) AS "received",
        COALESCE(changes."receivedWeight", '0') AS "receivedWeight",
        COALESCE(changes."receivedValue", '0') AS "receivedValue",
        COALESCE(changes."released", 0) AS "released",
        COALESCE(changes."releasedWeight", '0') AS "releasedWeight",
        COALESCE(changes."releasedValue", '0') AS "releasedValue",
        COALESCE(changes."sold", 0) AS "sold",
        COALESCE(changes."soldWeight", '0') AS "soldWeight",
        COALESCE(changes."soldValue", '0') AS "soldValue"
      FROM variants
      JOIN "inventory"."ProductVariant" variant ON variant."id" = variants."variantId"
      JOIN "inventory"."Metal" metal ON metal."id" = variant."metalId"
      LEFT JOIN current_stock stock ON stock."variantId" = variants."variantId"
      LEFT JOIN changes ON changes."variantId" = variants."variantId"
      ORDER BY variant."id"
    `);
  }
}
