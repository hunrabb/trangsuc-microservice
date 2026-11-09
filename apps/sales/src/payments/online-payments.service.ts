import { createHash, randomUUID } from 'node:crypto';
import { type AuthUser, BusinessError, outbox, violatedUniqueIndex } from '@jewelry/common';
import {
  confirmOnlinePaymentSchema,
  idempotencyKeySchema,
  onlinePaymentViewSchema,
  PAYMENT_RECOVERY_INTERVAL_MS,
  ROUTING_KEYS,
  type ConfirmOnlinePayment,
} from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import type { Prisma, OnlineOrder, OnlinePayment } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;
export function assertOnlinePaymentRole(user: AuthUser, branchId: string | null): void {
  if (
    !user.branches.some(
      (role) =>
        (role.role === 'ADMIN' && role.branchId === null) ||
        (role.role === 'MANAGER' && role.branchId === branchId && branchId !== null),
    )
  )
    throw new BusinessError(
      'FORBIDDEN',
      'Chỉ ADMIN hoặc MANAGER đúng chi nhánh xác minh tiền online',
      403,
    );
}
export async function paymentAudit(
  tx: Tx,
  order: OnlineOrder,
  paymentId: string,
  action: string,
  toStatus: string,
  actorId: string | null = null,
  reason: string | null = null,
): Promise<void> {
  await tx.onlinePaymentAudit.create({
    data: {
      orderId: order.id,
      paymentId,
      actorId,
      action,
      fromStatus: order.status,
      toStatus,
      reason,
    },
  });
}
export async function emitOnlinePaid(
  tx: Tx,
  order: OnlineOrder,
  payment: OnlinePayment,
): Promise<void> {
  if (
    !order.reservationId ||
    !order.total ||
    !order.total.equals(payment.amount) ||
    !['RECEIVED', 'RECONCILIATION_REQUIRED'].includes(payment.status)
  )
    throw new BusinessError(
      'PAYMENT_RECONCILIATION_REQUIRED',
      'Payment không có snapshot hợp lệ',
      409,
    );
  await outbox.add(tx, {
    eventType: ROUTING_KEYS.ORDER_PAID,
    aggregateType: 'OnlineOrder',
    aggregateId: order.id,
    payload: {
      channel: 'WEBSITE',
      orderId: order.id,
      paymentId: payment.id,
      reservationId: order.reservationId,
      amount: payment.amount.toFixed(2),
      currency: 'VND',
      receivedAt: payment.receivedAt.toISOString(),
    },
  });
}
export function presentOnlinePayment(row: OnlinePayment) {
  return onlinePaymentViewSchema.parse({
    id: row.id,
    orderId: row.orderId,
    amount: row.amount.toFixed(2),
    currency: row.currency,
    status: row.status,
    receivedAt: row.receivedAt.toISOString(),
  });
}
function referenceConflict(): BusinessError {
  return new BusinessError(
    'PAYMENT_REFERENCE_CONFLICT',
    'Giao dịch này đã được ghi nhận với dữ liệu khác',
    409,
  );
}

@Injectable()
export class OnlinePaymentsService {
  constructor(private readonly prisma: PrismaService) {}
  private async lockedOrder(
    tx: Tx,
    user: AuthUser,
    branchId: string,
    orderId: string,
  ): Promise<OnlineOrder> {
    await tx.$queryRaw`SELECT id FROM "sales"."OnlineOrder" WHERE id = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.onlineOrder.findUnique({ where: { id: orderId } });
    if (!order || order.branchId !== branchId)
      throw new BusinessError('NOT_FOUND', 'Không tìm thấy đơn tại chi nhánh', 404);
    assertOnlinePaymentRole(user, order.branchId);
    return order;
  }
  async confirm(
    user: AuthUser,
    branchId: string,
    orderId: string,
    key: string,
    input: ConfirmOnlinePayment,
  ) {
    const body = confirmOnlinePaymentSchema.parse(input);
    key = idempotencyKeySchema.parse(key);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ orderId, ...body }))
      .digest('hex');
    const replay = (existing: OnlinePayment, expectedHash?: string) => {
      if (expectedHash !== undefined && expectedHash !== requestHash)
        throw new BusinessError('IDEMPOTENCY_KEY_REUSED', 'Key đã dùng cho nội dung khác', 422);
      if (
        existing.orderId !== orderId ||
        !existing.amount.equals(body.amount) ||
        existing.currency !== body.currency ||
        existing.bankTxnRef !== body.bankTxnRef
      )
        throw referenceConflict();
      return presentOnlinePayment(existing);
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const order = await this.lockedOrder(tx, user, branchId, orderId);
        const priorKey = await tx.onlinePaymentRequest.findUnique({
          where: { actorId_idempotencyKey: { actorId: user.id, idempotencyKey: key } },
          include: { payment: true },
        });
        if (priorKey) return replay(priorKey.payment, priorKey.requestHash);
        const priorRef = await tx.onlinePayment.findUnique({
          where: { bankTxnRef: body.bankTxnRef },
        });
        if (priorRef) {
          const view = replay(priorRef);
          await tx.onlinePaymentRequest.create({
            data: { actorId: user.id, idempotencyKey: key, requestHash, paymentId: priorRef.id },
          });
          return view;
        }
        if (!order.total || !order.reservationId)
          throw new BusinessError(
            'PAYMENT_RECONCILIATION_REQUIRED',
            'Đơn chưa có snapshot giá/giữ hàng để đối chiếu',
            409,
          );
        if (!order.total.equals(body.amount))
          throw new BusinessError(
            'PAYMENT_AMOUNT_MISMATCH',
            'Số tiền phải khớp toàn bộ giá backend đã chốt',
            409,
          );
        const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        const live =
          order.status === 'AWAITING_PAYMENT' &&
          order.expiresAt !== null &&
          order.expiresAt > clock!.now &&
          order.activePaymentId === null;
        const payment = await tx.onlinePayment.create({
          data: {
            id: randomUUID(),
            orderId,
            ...body,
            actorId: user.id,
            idempotencyKey: key,
            requestHash,
            receivedAt: clock!.now,
            status: live ? 'RECEIVED' : 'REFUND_PENDING',
          },
        });
        await tx.onlinePaymentRequest.create({
          data: { actorId: user.id, idempotencyKey: key, requestHash, paymentId: payment.id },
        });
        // Giao dịch thực thứ hai phải được giữ để đối soát/hoàn tiền; không xác nhận đơn lần hai.
        if (!live) {
          if (!order.activePaymentId)
            await tx.onlineOrder.update({
              where: { id: orderId },
              data: { activePaymentId: payment.id, status: 'REFUND_PENDING', needsReview: true },
            });
          await paymentAudit(
            tx,
            order,
            payment.id,
            'MANUAL_RECEIPT_REFUND_REQUESTED',
            order.activePaymentId ? order.status : 'REFUND_PENDING',
            user.id,
            'Tiền đến muộn hoặc giao dịch thực bổ sung',
          );
        } else {
          await tx.onlineOrder.update({
            where: { id: orderId },
            data: {
              activePaymentId: payment.id,
              status: 'PAYMENT_PROCESSING',
              paymentAttempts: 0,
              recoveryAfter: new Date(clock!.now.getTime() + PAYMENT_RECOVERY_INTERVAL_MS),
              needsReview: false,
            },
          });
          await paymentAudit(
            tx,
            order,
            payment.id,
            'MANUAL_RECEIPT_VERIFIED',
            'PAYMENT_PROCESSING',
            user.id,
          );
          await emitOnlinePaid(tx, order, payment);
        }
        return presentOnlinePayment(payment);
      });
    } catch (error) {
      const index = violatedUniqueIndex(error);
      if (
        ![
          'OnlinePayment_actorId_idempotencyKey_key',
          'OnlinePaymentRequest_actorId_idempotencyKey_key',
          'OnlinePayment_bankTxnRef_key',
        ].includes(index ?? '')
      )
        throw error;
      return this.prisma.$transaction(async (tx) => {
        await this.lockedOrder(tx, user, branchId, orderId);
        if (index !== 'OnlinePayment_bankTxnRef_key') {
          const prior = await tx.onlinePaymentRequest.findUniqueOrThrow({
            where: { actorId_idempotencyKey: { actorId: user.id, idempotencyKey: key } },
            include: { payment: true },
          });
          return replay(prior.payment, prior.requestHash);
        }
        const prior = await tx.onlinePayment.findUniqueOrThrow({
          where: { bankTxnRef: body.bankTxnRef },
        });
        const view = replay(prior);
        const alias = await tx.onlinePaymentRequest.upsert({
          where: { actorId_idempotencyKey: { actorId: user.id, idempotencyKey: key } },
          create: { actorId: user.id, idempotencyKey: key, requestHash, paymentId: prior.id },
          update: {},
        });
        if (alias.requestHash !== requestHash || alias.paymentId !== prior.id)
          throw new BusinessError('IDEMPOTENCY_KEY_REUSED', 'Key đã dùng cho nội dung khác', 422);
        return view;
      });
    }
  }
  async list(user: AuthUser, branchId: string, orderId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockedOrder(tx, user, branchId, orderId);
      const rows = await tx.onlinePayment.findMany({
        where: { orderId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      });
      return rows.map((row) => ({
        ...presentOnlinePayment(row),
        bankTxnRef: row.bankTxnRef,
        evidenceRef: row.evidenceRef,
      }));
    });
  }
  async requestRefund(
    user: AuthUser,
    branchId: string,
    orderId: string,
    paymentId: string,
    reason: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockedOrder(tx, user, branchId, orderId);
      const payment = await tx.onlinePayment.findFirst({ where: { id: paymentId, orderId } });
      if (!payment) throw new BusinessError('NOT_FOUND', 'Không tìm thấy giao dịch', 404);
      if (payment.status === 'REFUND_PENDING') return presentOnlinePayment(payment);
      const changed = await tx.onlinePayment.update({
        where: { id: paymentId },
        data: { status: 'REFUND_PENDING' },
      });
      if (order.activePaymentId === paymentId)
        await tx.onlineOrder.update({
          where: { id: orderId },
          data: { status: 'REFUND_PENDING', needsReview: true },
        });
      await paymentAudit(
        tx,
        order,
        paymentId,
        'REFUND_REQUESTED',
        order.activePaymentId === paymentId ? 'REFUND_PENDING' : order.status,
        user.id,
        reason,
      );
      return presentOnlinePayment(changed);
    });
  }
}
