import { createHash, randomUUID } from 'node:crypto';
import { BusinessError, outbox, violatedUniqueIndex } from '@jewelry/common';
import {
  ONLINE_RESERVATION_TTL_MS,
  ONLINE_PENDING_REVIEW_MS,
  canonicalCart,
  checkoutAuthorizationSchema,
  createOnlineOrderSchema,
  idempotencyKeySchema,
  onlineCartSchema,
  onlineOrderViewSchema,
  type CreateOnlineOrder,
  ROUTING_KEYS,
} from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import type { OnlineOrder, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;
export function checkoutAccessHash(authorization: string): string {
  checkoutAuthorizationSchema.parse(authorization);
  return createHash('sha256').update(authorization.slice('Checkout '.length)).digest('hex');
}
// chuẩn hóa giỏ hàng
export function canonicalCheckout(body: CreateOnlineOrder) {
  const checked = createOnlineOrderSchema.parse(body);
  return { ...checked, items: canonicalCart(checked.items) };
}
export function checkoutRequestHash(body: CreateOnlineOrder): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalCheckout(body)))
    .digest('hex');
}
export async function emitOnlineCreated(tx: Tx, row: OnlineOrder): Promise<void> {
  await outbox.add(tx, {
    eventType: ROUTING_KEYS.ORDER_CREATED,
    aggregateType: 'OnlineOrder',
    aggregateId: row.id,
    payload: {
      channel: 'WEBSITE',
      orderId: row.id,
      requestHash: row.requestHash,
      deadlineAt: row.deadlineAt.toISOString(),
      items: onlineCartSchema.parse(row.requestedItems),
    },
  });
}
export async function emitOnlineCancelled(tx: Tx, orderId: string): Promise<void> {
  await outbox.add(tx, {
    eventType: ROUTING_KEYS.ORDER_CANCELLED,
    aggregateType: 'OnlineOrder',
    aggregateId: orderId,
    payload: { channel: 'WEBSITE', orderId },
  });
}
export async function cancelOnline(
  tx: Tx,
  row: OnlineOrder,
  failureCode: string | null,
): Promise<void> {
  const result = await tx.onlineOrder.updateMany({
    where: { id: row.id, status: { in: ['PENDING', 'AWAITING_PAYMENT'] }, activePaymentId: null },
    data: { status: 'CANCELLED', failureCode },
  });
  if (result.count) await emitOnlineCancelled(tx, row.id);
}

@Injectable()
export class OnlineOrdersService {
  constructor(private readonly prisma: PrismaService) {}
  async create(
    authorization: string,
    key: string,
    body: CreateOnlineOrder,
    accountId: string | null = null,
  ) {
    const accessHash = checkoutAccessHash(authorization);
    idempotencyKeySchema.parse(key);
    const request = canonicalCheckout(body);
    const requestHash = checkoutRequestHash(request);
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        const now = clock!.now;
        const row = await tx.onlineOrder.create({
          data: {
            id: randomUUID(),
            code: `WEB-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
            accessHash,
            accountId,
            idempotencyKey: key,
            requestHash,
            requestedItems: request.items,
            recipientName: request.recipientName,
            recipientPhone: request.recipientPhone,
            shippingAddress: request.shippingAddress,
            email: request.email,
            deadlineAt: new Date(now.getTime() + ONLINE_RESERVATION_TTL_MS),
            recoveryAfter: new Date(now.getTime() + ONLINE_PENDING_REVIEW_MS),
          },
        });
        await emitOnlineCreated(tx, row);
        return row.id;
      });
    } catch (error) {
      if (violatedUniqueIndex(error) !== 'OnlineOrder_accessHash_idempotencyKey_key') throw error;
      const row = await this.prisma.onlineOrder.findUniqueOrThrow({
        where: { accessHash_idempotencyKey: { accessHash, idempotencyKey: key } },
      });
      if (row.requestHash !== requestHash || row.accountId !== accountId)
        throw new BusinessError(
          'IDEMPOTENCY_KEY_REUSED',
          'Key đã được dùng cho nội dung khác',
          422,
        );
      id = row.id;
    }
    return this.get(authorization, id);
  }
  async forAccount(accountId: string, page: number, pageSize: number) {
    const where = { accountId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.onlineOrder.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { items: { orderBy: { id: 'asc' } } },
      }),
      this.prisma.onlineOrder.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({ ...this.present(row), createdAt: row.createdAt.toISOString() })),
      page,
      pageSize,
      total,
    };
  }
  async accountOrder(accountId: string, id: string) {
    const row = await this.prisma.onlineOrder.findFirst({
      where: { id, accountId },
      include: { items: { orderBy: { id: 'asc' } } },
    });
    if (!row) throw new BusinessError('NOT_FOUND', 'Không tìm thấy đơn hàng', 404);
    return { ...this.present(row), createdAt: row.createdAt.toISOString() };
  }
  async get(authorization: string, id: string) {
    const row = await this.prisma.onlineOrder.findFirst({
      where: { id, accessHash: checkoutAccessHash(authorization) },
      include: { items: { orderBy: { id: 'asc' } } },
    });
    if (!row) throw new BusinessError('NOT_FOUND', 'Không tìm thấy đơn hàng', 404);
    return this.present(row);
  }
  async byKey(authorization: string, key: string) {
    idempotencyKeySchema.parse(key);
    const row = await this.prisma.onlineOrder.findUnique({
      where: {
        accessHash_idempotencyKey: {
          accessHash: checkoutAccessHash(authorization),
          idempotencyKey: key,
        },
      },
      include: { items: { orderBy: { id: 'asc' } } },
    });
    if (!row) throw new BusinessError('NOT_FOUND', 'Không tìm thấy đơn hàng', 404);
    return this.present(row);
  }
  async cancel(authorization: string, id: string) {
    const accessHash = checkoutAccessHash(authorization);
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "sales"."OnlineOrder" WHERE id = ${id}::uuid AND "accessHash" = ${accessHash} FOR UPDATE`;
      if (!locked.length) throw new BusinessError('NOT_FOUND', 'Không tìm thấy đơn hàng', 404);
      const row = await tx.onlineOrder.findUniqueOrThrow({ where: { id } });
      await this.cancelLocked(tx, row);
    });
    return this.get(authorization, id);
  }
  async cancelAccount(accountId: string, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "sales"."OnlineOrder" WHERE id = ${id}::uuid AND "accountId" = ${accountId}::uuid FOR UPDATE`;
      if (!locked.length) throw new BusinessError('NOT_FOUND', 'Không tìm thấy đơn hàng', 404);
      const row = await tx.onlineOrder.findUniqueOrThrow({ where: { id } });
      await this.cancelLocked(tx, row);
    });
    return this.accountOrder(accountId, id);
  }
  private async cancelLocked(tx: Tx, row: OnlineOrder) {
    if (!['PENDING', 'AWAITING_PAYMENT', 'CANCELLED'].includes(row.status) || row.activePaymentId)
      throw new BusinessError(
        'INVALID_STATE',
        'Đơn đã nhận tiền, cần quy trình đối soát/hoàn tiền',
        409,
      );
    await cancelOnline(tx, row, null);
  }
  private present(row: Prisma.OnlineOrderGetPayload<{ include: { items: true } }>) {
    return onlineOrderViewSchema.parse({
      id: row.id,
      code: row.code,
      status: row.status,
      total: row.total?.toFixed(2) ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      needsReview: row.needsReview,
      failureCode: row.failureCode,
      items: row.items.map((i) => ({
        variantId: i.variantId,
        sku: i.sku,
        productName: i.productName,
        price: i.price.toFixed(2),
      })),
    });
  }
}
