import { BusinessError, outbox, runWithLockRetry } from '@jewelry/common';
import { ROUTING_KEYS, type ExchangeHold, type ReserveExchange } from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import { Prisma, type ExchangeHold as HoldRow } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { findCurrentPrice } from '../catalog/metals.service';
import { computeItemPrice } from '../pricing/pricing';

type Tx = Prisma.TransactionClient;
const unavailable = () => new BusinessError('ITEM_NOT_AVAILABLE', 'Chiếc không còn bán được', 409);
const invalid = () =>
  new BusinessError('INVALID_STATE', 'Giữ hàng đổi không ở trạng thái cho phép', 409);
const TTL_MS = 15 * 60_000;
const PROTECTED_MS = 3 * 24 * 60 * 60_000;

function view(row: HoldRow): ExchangeHold {
  return {
    exchangeId: row.exchangeId,
    branchId: row.branchId,
    status: row.status,
    tagCode: row.tagCode,
    itemId: row.itemId,
    variantId: row.variantId,
    metalId: row.metalId,
    productName: row.productName,
    weight: row.weight.toFixed(4),
    laborFee: row.laborFee.toFixed(2),
    metalSellPricePerChi: row.metalSellPricePerChi.toFixed(2),
    price: row.price.toFixed(2),
    costPrice: row.costPrice.toFixed(2),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

@Injectable()
export class ExchangeHoldsService {
  constructor(private readonly prisma: PrismaService) {}
  private write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return runWithLockRetry(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        return fn(tx);
      }),
    );
  }
  private async operation(tx: Tx, id: string, release = false) {
    await tx.$executeRaw`INSERT INTO "inventory"."ExchangeOperation" ("exchangeId","releasedAt") VALUES (${id}::uuid,${release ? new Date() : null}) ON CONFLICT ("exchangeId") DO NOTHING`;
    const [row] = await tx.$queryRaw<
      { releasedAt: Date | null }[]
    >`SELECT "releasedAt" FROM "inventory"."ExchangeOperation" WHERE "exchangeId"=${id}::uuid FOR UPDATE`;
    return row!;
  }
  private async locked(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT "exchangeId" FROM "inventory"."ExchangeHold" WHERE "exchangeId"=${id}::uuid FOR UPDATE`;
    return tx.exchangeHold.findUnique({ where: { exchangeId: id } });
  }
  async reserve({ exchangeId, branchId, tagCode }: ReserveExchange): Promise<ExchangeHold> {
    return this.write(async (tx) => {
      if ((await this.operation(tx, exchangeId)).releasedAt) throw invalid();
      const prior = await this.locked(tx, exchangeId);
      if (prior) {
        if (prior.branchId !== branchId || prior.tagCode !== tagCode)
          throw new BusinessError('IDEMPOTENCY_KEY_REUSED', 'exchangeId đã dùng', 422);
        return view(prior);
      }
      const [locked] = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "inventory"."JewelryItem" WHERE "tagCode"=${tagCode} FOR UPDATE`;
      if (!locked) throw unavailable();
      const item = await tx.jewelryItem.findUniqueOrThrow({
        where: { id: locked.id },
        include: { warehouse: true, variant: { include: { product: true, metal: true } } },
      });
      if (
        item.status !== 'IN_STOCK' ||
        item.warehouse.branchId !== branchId ||
        !item.warehouse.isActive ||
        !item.variant.isActive ||
        !item.variant.product.isActive ||
        !item.variant.metal.isActive
      )
        throw unavailable();
      const price = await findCurrentPrice(tx, item.variant.metalId);
      if (!price) throw new BusinessError('METAL_PRICE_NOT_SET', 'Chưa có giá bán kim loại', 409);
      const sale = computeItemPrice(item.weight, price.sellPrice, item.laborFee);
      const { count } = await tx.jewelryItem.updateMany({
        where: { id: item.id, status: 'IN_STOCK' },
        data: { status: 'RESERVED', version: { increment: 1 } },
      });
      if (count !== 1) throw unavailable();
      const row = await tx.exchangeHold.create({
        data: {
          exchangeId,
          branchId,
          tagCode,
          itemId: item.id,
          variantId: item.variantId,
          metalId: item.variant.metalId,
          productName: item.variant.product.name,
          weight: item.weight,
          laborFee: item.laborFee,
          metalSellPricePerChi: price.sellPrice,
          price: sale,
          costPrice: item.costPrice,
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + TTL_MS),
        },
      });
      return view(row);
    });
  }
  async state(id: string): Promise<ExchangeHold | null> {
    const row = await this.prisma.exchangeHold.findUnique({ where: { exchangeId: id } });
    return row ? view(row) : null;
  }
  async protect(id: string): Promise<ExchangeHold> {
    return this.write(async (tx) => {
      if ((await this.operation(tx, id)).releasedAt) throw invalid();
      const row = await this.locked(tx, id);
      if (!row) throw invalid();
      if (row.status === 'PROTECTED' || row.status === 'CONSUMED') return view(row);
      if (row.status !== 'ACTIVE' || !row.expiresAt || row.expiresAt <= new Date()) throw invalid();
      const [item] = await tx.$queryRaw<
        { status: string }[]
      >`SELECT status FROM "inventory"."JewelryItem" WHERE id=${row.itemId}::uuid FOR UPDATE`;
      if (item?.status !== 'RESERVED') throw invalid();
      return view(
        await tx.exchangeHold.update({
          where: { exchangeId: id },
          data: { status: 'PROTECTED', expiresAt: new Date(Date.now() + PROTECTED_MS) },
        }),
      );
    });
  }
  async consume(id: string): Promise<ExchangeHold> {
    return this.write(async (tx) => {
      if ((await this.operation(tx, id)).releasedAt) throw invalid();
      const row = await this.locked(tx, id);
      if (!row) throw invalid();
      if (row.status === 'CONSUMED') return view(row);
      if (row.status !== 'PROTECTED' || !row.expiresAt || row.expiresAt <= new Date())
        throw invalid();
      const [item] = await tx.$queryRaw<
        { status: string }[]
      >`SELECT status FROM "inventory"."JewelryItem" WHERE id=${row.itemId}::uuid FOR UPDATE`;
      if (item?.status !== 'RESERVED') throw invalid();
      const changed = await tx.jewelryItem.updateMany({
        where: { id: row.itemId, status: 'RESERVED' },
        data: {
          status: 'SOLD',
          orderId: id,
          soldAt: new Date(),
          metalPriceAtSale: row.metalSellPricePerChi,
          priceAtSale: row.price,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw invalid();
      await tx.stockMovement.create({
        data: {
          jewelryItemId: row.itemId,
          warehouseId: (
            await tx.jewelryItem.findUniqueOrThrow({
              where: { id: row.itemId },
              select: { warehouseId: true },
            })
          ).warehouseId,
          type: 'SALE',
          toStatus: 'SOLD',
          refType: 'Exchange',
          refId: id,
        },
      });
      const result = await tx.exchangeHold.update({
        where: { exchangeId: id },
        data: { status: 'CONSUMED', expiresAt: null },
      });
      await outbox.add(tx, {
        eventType: ROUTING_KEYS.STOCK_CHANGED,
        aggregateType: 'ExchangeHold',
        aggregateId: id,
        payload: { orderId: id, branchId: row.branchId, reason: 'SOLD', tagCodes: [row.tagCode] },
      });
      return view(result);
    });
  }
  async release(id: string): Promise<void> {
    await this.write(async (tx) => {
      const op = await this.operation(tx, id, true);
      const row = await this.locked(tx, id);
      if (row?.status === 'PROTECTED' || row?.status === 'CONSUMED') throw invalid();
      if (row?.status === 'ACTIVE') {
        await tx.$queryRaw`SELECT id FROM "inventory"."JewelryItem" WHERE id=${row.itemId}::uuid FOR UPDATE`;
        const changed = await tx.jewelryItem.updateMany({
          where: { id: row.itemId, status: 'RESERVED' },
          data: { status: 'IN_STOCK', version: { increment: 1 } },
        });
        if (changed.count !== 1) throw invalid();
        await tx.exchangeHold.update({
          where: { exchangeId: id },
          data: { status: 'RELEASED', expiresAt: null },
        });
      }
      if (!op.releasedAt)
        await tx.exchangeOperation.update({
          where: { exchangeId: id },
          data: { releasedAt: new Date() },
        });
    });
  }
  async expire(id: string): Promise<void> {
    await this.write(async (tx) => {
      await this.operation(tx, id);
      const row = await this.locked(tx, id);
      if (!row || row.status !== 'ACTIVE' || !row.expiresAt || row.expiresAt > new Date()) return;
      await tx.$queryRaw`SELECT id FROM "inventory"."JewelryItem" WHERE id=${row.itemId}::uuid FOR UPDATE`;
      const changed = await tx.jewelryItem.updateMany({
        where: { id: row.itemId, status: 'RESERVED' },
        data: { status: 'IN_STOCK', version: { increment: 1 } },
      });
      if (changed.count !== 1) throw invalid();
      await tx.exchangeHold.update({
        where: { exchangeId: id },
        data: { status: 'EXPIRED', expiresAt: null },
      });
    });
  }
}
