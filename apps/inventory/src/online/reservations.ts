import { randomUUID } from 'node:crypto';
import { outbox, PermanentError } from '@jewelry/common';
import {
  ONLINE_RESERVATION_TTL_MS,
  canonicalCart,
  type OnlineOrderCreated,
  onlineOrderCreatedSchema,
  ROUTING_KEYS,
  stockReservedSchema,
  type StockReserved,
} from '@jewelry/contracts';
import { Prisma } from '../generated/prisma/client';
import { computeItemPrice } from '../pricing/pricing';
import { findCurrentPrice } from '../catalog/metals.service';

type Tx = Prisma.TransactionClient;
type Reservation = Prisma.StockReservationGetPayload<{ include: { items: true } }>;

export async function lockReservation(tx: Tx, orderId: string): Promise<Reservation> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
  await tx.$executeRaw`
    INSERT INTO "inventory"."StockReservation" (id,"orderId",status,"updatedAt")
    VALUES (${randomUUID()}::uuid, ${orderId}::uuid, 'RELEASED', now())
    ON CONFLICT ("orderId") DO NOTHING`;
  await tx.$queryRaw`SELECT id FROM "inventory"."StockReservation" WHERE "orderId" = ${orderId}::uuid FOR UPDATE`;
  return tx.stockReservation.findUniqueOrThrow({ where: { orderId }, include: { items: true } });
}
async function emitFailure(
  tx: Tx,
  orderId: string,
  code:
    'ITEM_NOT_AVAILABLE' | 'RESERVATION_EXPIRED' | 'RESERVATION_RELEASED' | 'PRICE_NOT_AVAILABLE',
) {
  await outbox.add(tx, {
    eventType: ROUTING_KEYS.STOCK_RESERVE_FAILED,
    aggregateType: 'StockReservation',
    aggregateId: orderId,
    payload: { channel: 'WEBSITE', orderId, code },
  });
}
async function emitReserved(tx: Tx, row: Reservation): Promise<void> {
  if (!row.warehouseId || !row.branchId || !row.expiresAt)
    throw new PermanentError('Reservation thiếu snapshot');
  await outbox.add(tx, {
    eventType: ROUTING_KEYS.STOCK_RESERVED,
    aggregateType: 'StockReservation',
    aggregateId: row.orderId,
    payload: stockReservedSchema.parse({
      channel: 'WEBSITE',
      orderId: row.orderId,
      reservationId: row.id,
      warehouseId: row.warehouseId,
      branchId: row.branchId,
      expiresAt: row.expiresAt.toISOString(),
      total: row.total.toFixed(2),
      items: row.items.map((i) => ({
        jewelryItemId: i.jewelryItemId,
        variantId: i.variantId,
        sku: i.sku,
        productName: i.productName,
        price: i.price.toFixed(2),
      })),
    }),
  });
}
/** Consumer transaction đã bao gồm ProcessedEvent. Thất bại DB rollback cả dấu và outbox. */
export async function reserveOnlineOrder(tx: Tx, input: OnlineOrderCreated): Promise<void> {
  const request = onlineOrderCreatedSchema.parse(input);
  // INSERT dùng FAILED làm trạng thái tạm, khác tombstone RELEASED từ huỷ đến trước.
  await tx.$executeRaw`
    INSERT INTO "inventory"."StockReservation" (id,"orderId",status,"requestHash","updatedAt")
    VALUES (${randomUUID()}::uuid, ${request.orderId}::uuid, 'FAILED', ${request.requestHash}, now())
    ON CONFLICT ("orderId") DO NOTHING`;
  const reservation = await lockReservation(tx, request.orderId);
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const now = clock!.now;
  if (reservation.requestHash !== null && reservation.requestHash !== request.requestHash)
    throw new PermanentError('orderId online bị tái sử dụng cho nội dung khác');
  if (reservation.status === 'ACTIVE') {
    if (reservation.expiresAt! <= now) await releaseOnlineOrder(tx, request.orderId, 'EXPIRED');
    else await emitReserved(tx, reservation);
    return;
  }
  if (reservation.status === 'RELEASED' || reservation.status === 'EXPIRED') {
    await emitFailure(
      tx,
      request.orderId,
      reservation.status === 'EXPIRED' ? 'RESERVATION_EXPIRED' : 'RESERVATION_RELEASED',
    );
    return;
  }
  if (['PAYMENT_REVIEW', 'CONSUMED', 'PAID_HELD'].includes(reservation.status)) return;
  if (reservation.failureCode) {
    await emitFailure(
      tx,
      request.orderId,
      reservation.failureCode === 'PRICE_NOT_AVAILABLE'
        ? 'PRICE_NOT_AVAILABLE'
        : 'ITEM_NOT_AVAILABLE',
    );
    return;
  }
  const expiresAt = new Date(
    Math.min(new Date(request.deadlineAt).getTime(), now.getTime() + ONLINE_RESERVATION_TTL_MS),
  );
  if (expiresAt <= now) {
    await tx.stockReservation.update({
      where: { id: reservation.id },
      data: { status: 'EXPIRED' },
    });
    await emitFailure(tx, request.orderId, 'RESERVATION_EXPIRED');
    return;
  }
  const items = canonicalCart(request.items);
  const candidates = await tx.$queryRaw<{ warehouseId: string; branchId: string }[]>(Prisma.sql`
    WITH needed AS (SELECT "variantId"::uuid AS variant_id, quantity FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS n("variantId" text, quantity int)),
    stock AS (
      SELECT w.id, w."branchId", n.variant_id, n.quantity,
        greatest(count(i.id)::int - coalesce(b.quantity,0),0) AS available
      FROM "inventory"."Warehouse" w CROSS JOIN needed n
      LEFT JOIN "inventory"."JewelryItem" i ON i."warehouseId" = w.id AND i."variantId" = n.variant_id AND i.status = 'IN_STOCK'
      LEFT JOIN "inventory"."OnlineStockBuffer" b ON b."warehouseId" = w.id AND b."variantId" = n.variant_id
      WHERE w."isActive" AND w."acceptsOnlineOrders"
      GROUP BY w.id, w."branchId", n.variant_id, n.quantity, b.quantity)
    SELECT id AS "warehouseId", "branchId" FROM stock GROUP BY id,"branchId"
    HAVING bool_and(available >= quantity) ORDER BY sum(available) DESC, "branchId", id`);
  let priceMissing = false;
  for (const warehouse of candidates) {
    // Khoá cấu hình kho, rồi khoá các chiếc. SKIP LOCKED tránh đợi vòng với POS.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "inventory"."Warehouse" WHERE id = ${warehouse.warehouseId}::uuid AND "isActive" AND "acceptsOnlineOrders" FOR UPDATE`;
    if (!locked.length) continue;
    const selected: StockReserved['items'] = [];
    let complete = true;
    for (const line of items) {
      const [variant] = await tx.$queryRaw<{ metalId: string; sku: string; productName: string }[]>`
        SELECT v."metalId", v.sku, p.name AS "productName" FROM "inventory"."ProductVariant" v
        JOIN "inventory"."Product" p ON p.id = v."productId" JOIN "inventory"."Category" c ON c.id = p."categoryId"
        JOIN "inventory"."Metal" m ON m.id = v."metalId"
        WHERE v.id = ${line.variantId}::uuid AND v."isActive" AND p."isActive" AND p."publishedOnline" AND c."isActive" AND m."isActive"
        FOR SHARE OF v,p,c,m`;
      if (!variant) {
        complete = false;
        break;
      }
      const price = await findCurrentPrice(tx, variant.metalId);
      if (!price) {
        priceMissing = true;
        complete = false;
        break;
      }
      const buffer = await tx.onlineStockBuffer.findUnique({
        where: {
          warehouseId_variantId: { warehouseId: warehouse.warehouseId, variantId: line.variantId },
        },
      });
      const required = line.quantity + (buffer?.quantity ?? 0);
      // Lock cả phần buffer, nhưng chỉ đưa số chiếc khách mua ra khỏi DB để giới hạn bộ nhớ.
      const rows = await tx.$queryRaw<{ id: string; available: bigint }[]>`
        WITH locked AS (
          SELECT id FROM "inventory"."JewelryItem" WHERE "warehouseId" = ${warehouse.warehouseId}::uuid
          AND "variantId" = ${line.variantId}::uuid AND status = 'IN_STOCK'
          ORDER BY id LIMIT ${required} FOR UPDATE SKIP LOCKED)
        SELECT id, count(*) OVER() AS available FROM locked ORDER BY id LIMIT ${line.quantity}`;
      if (rows.length !== line.quantity || Number(rows[0]?.available ?? 0) < required) {
        complete = false;
        break;
      }
      const physical = await tx.jewelryItem.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
        select: { id: true, weight: true, laborFee: true },
      });
      for (const item of physical)
        selected.push({
          jewelryItemId: item.id,
          variantId: line.variantId,
          sku: variant.sku,
          productName: variant.productName,
          price: computeItemPrice(item.weight, price.sellPrice, item.laborFee).toFixed(2),
        });
    }
    if (!complete) continue;
    const total = selected.reduce((sum, i) => sum.add(i.price), new Prisma.Decimal(0));
    if (total.gt('999999999999999999.99')) {
      priceMissing = true;
      continue;
    }
    const [allocationClock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    if (expiresAt <= allocationClock!.now) {
      await tx.stockReservation.update({
        where: { id: reservation.id },
        data: { status: 'EXPIRED' },
      });
      await emitFailure(tx, request.orderId, 'RESERVATION_EXPIRED');
      return;
    }
    const { count } = await tx.jewelryItem.updateMany({
      where: { id: { in: selected.map((i) => i.jewelryItemId) }, status: 'IN_STOCK' },
      data: { status: 'RESERVED', version: { increment: 1 } },
    });
    if (count !== selected.length)
      throw new PermanentError('Conditional reservation update không khớp các chiếc đã khoá');
    const result = await tx.stockReservation.update({
      where: { id: reservation.id },
      data: {
        status: 'ACTIVE',
        expiresAt,
        warehouseId: warehouse.warehouseId,
        branchId: warehouse.branchId,
        total,
        items: { create: selected },
      },
      include: { items: true },
    });
    await emitReserved(tx, result);
    return;
  }
  const failureCode = priceMissing ? 'PRICE_NOT_AVAILABLE' : 'ITEM_NOT_AVAILABLE';
  await tx.stockReservation.update({
    where: { id: reservation.id },
    data: { status: 'FAILED', failureCode },
  });
  await emitFailure(tx, request.orderId, failureCode);
}

/** Cùng khoá orderId với reserve/expiry. Tuyệt đối không UPDATE SOLD hoặc lượt giữ khác. */
export async function releaseOnlineOrder(
  tx: Tx,
  orderId: string,
  reason: 'RELEASED' | 'EXPIRED',
): Promise<void> {
  const row = await lockReservation(tx, orderId);
  if (row.status !== 'ACTIVE') return;
  if (reason === 'EXPIRED') {
    const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    if (row.expiresAt === null || row.expiresAt > clock!.now) return;
  }
  const ids = row.items
    .filter((i) => i.isActive)
    .map((i) => i.jewelryItemId)
    .sort();
  const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT id,status FROM "inventory"."JewelryItem" WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
  if (locked.length !== ids.length || locked.some((i) => i.status !== 'RESERVED')) {
    // Trạng thái bán/thu tiền chưa rõ: giữ dấu để đối soát, không giải phóng hàng.
    await tx.stockReservation.update({ where: { id: row.id }, data: { status: 'PAYMENT_REVIEW' } });
    return;
  }
  const { count } = await tx.jewelryItem.updateMany({
    where: { id: { in: ids }, status: 'RESERVED' },
    data: { status: 'IN_STOCK', version: { increment: 1 } },
  });
  if (count !== ids.length)
    throw new PermanentError('Release reservation không khớp số chiếc đã khoá');
  await tx.stockReservationItem.updateMany({
    where: { reservationId: row.id, isActive: true },
    data: { isActive: false },
  });
  await tx.stockReservation.update({ where: { id: row.id }, data: { status: reason } });
  if (reason === 'EXPIRED')
    await outbox.add(tx, {
      eventType: ROUTING_KEYS.STOCK_RESERVATION_EXPIRED,
      aggregateType: 'StockReservation',
      aggregateId: orderId,
      payload: { channel: 'WEBSITE', orderId, reservationId: row.id },
    });
}
