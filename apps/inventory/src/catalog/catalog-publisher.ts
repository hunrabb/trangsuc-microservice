import { outbox } from '@jewelry/common';
import { ROUTING_KEYS, productSnapshotSchema } from '@jewelry/contracts';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { computeItemPrice } from '../pricing/pricing';
import { findCurrentPrice } from './metals.service';

/** Đồng bộ theo lô; tự nhận giá tới thời điểm hiệu lực, dữ liệu nhập và thay đổi tồn từ POS. */
@Injectable()
export class CatalogPublisher implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(CatalogPublisher.name);
  constructor(private readonly prisma: PrismaService) {}
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
    void this.tick();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.replay();
    } catch (error) {
      this.logger.error('Catalog reconciliation failed; retry next interval', error);
    } finally {
      this.running = false;
    }
  }
  async replay(): Promise<void> {
    let cursor: string | undefined;
    let failures = 0;
    for (;;) {
      const rows = await this.prisma.product.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 50,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const row of rows) {
        try {
          await this.publish(row.id);
        } catch (error) {
          failures++;
          this.logger.error(`Không đồng bộ được mẫu ${row.id}`, error);
        }
      }
      if (rows.length < 50) break;
      cursor = rows.at(-1)!.id;
    }
    if (failures) throw new Error(`Không đồng bộ được ${failures} mẫu; sẽ thử lại lượt sau`);
  }
  async publish(id: string): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        // Serialize writers before taking a coherent product/stock/price snapshot.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('catalog'), hashtext(${id}))`;
        const p = await tx.product.update({
          where: { id },
          data: { catalogVersion: { increment: 1 } },
          include: {
            category: true,
            variants: { orderBy: { id: 'asc' }, take: 201, include: { metal: true } },
          },
        });
        const capturedAt = new Date().toISOString();
        const version = p.catalogVersion;
        const variants = [];
        const active =
          p.publishedOnline && p.isActive && p.category.isActive && p.variants.length <= 200;
        for (const v of p.variants.slice(0, 200)) {
          let available = 0;
          let price: Prisma.Decimal | null = null;
          if (active && v.isActive && v.metal.isActive) {
            const metalPrice = await findCurrentPrice(tx, v.metalId);
            const warehouses = await tx.warehouse.findMany({
              where: { isActive: true, acceptsOnlineOrders: true },
              select: { id: true },
            });
            for (const warehouse of warehouses) {
              const buffer = await tx.onlineStockBuffer.findUnique({
                where: { warehouseId_variantId: { warehouseId: warehouse.id, variantId: v.id } },
              });
              // Count and estimate from IN_STOCK only; RESERVED/SOLD never contribute.
              let count = 0;
              let warehousePrice: Prisma.Decimal | null = null;
              let cursor: string | undefined;
              for (;;) {
                const items = await tx.jewelryItem.findMany({
                  where: { warehouseId: warehouse.id, variantId: v.id, status: 'IN_STOCK' },
                  select: { id: true, weight: true, laborFee: true },
                  orderBy: { id: 'asc' },
                  take: 500,
                  ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                });
                count += items.length;
                if (metalPrice)
                  for (const item of items) {
                    const candidate = computeItemPrice(
                      item.weight,
                      metalPrice.sellPrice,
                      item.laborFee,
                    );
                    if (warehousePrice === null || candidate.lt(warehousePrice))
                      warehousePrice = candidate;
                  }
                if (items.length < 500) break;
                cursor = items.at(-1)!.id;
              }
              const sellable = Math.max(0, count - (buffer?.quantity ?? 0));
              if (warehousePrice && sellable > 0) {
                available += sellable;
                if (price === null || warehousePrice.lt(price)) price = warehousePrice;
              }
            }
            variants.push({
              id: v.id,
              sku: v.sku,
              name: v.name,
              metalKind: v.metal.kind,
              estimatedPrice: price?.toFixed(2) ?? null,
            });
          }
          await outbox.add(tx, {
            eventType: ROUTING_KEYS.STOCK_AVAILABILITY_CHANGED,
            aggregateType: 'Product',
            aggregateId: id,
            payload: { variantId: v.id, available, version, capturedAt },
          });
        }
        const payload = productSnapshotSchema.parse({
          id,
          categoryId: p.categoryId,
          categoryName: p.category.name,
          name: p.name,
          description: p.description,
          imageUrl: p.imageUrl,
          isActive: active,
          version,
          capturedAt,
          variants,
        });
        await outbox.add(tx, {
          eventType: ROUTING_KEYS.PRODUCT_SNAPSHOT,
          aggregateType: 'Product',
          aggregateId: id,
          payload,
        });
      },
      { isolationLevel: 'Serializable', timeout: 20_000 },
    );
  }
}
