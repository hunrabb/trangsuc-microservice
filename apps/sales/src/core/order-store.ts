import { createHash, randomUUID } from 'node:crypto';
import { type AuthUser, BusinessError, violatedUniqueIndex } from '@jewelry/common';
import {
  type CreatePosOrderRequest,
  type DeductStockResponse,
  ROUTING_KEYS,
} from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertOrderBranch,
  invalidOrderState,
  orderBusy,
  type OrderFailure,
  type OrderRecord,
} from './order-record';
import { changeOrderStatus, emitOrderEvent, orderTransaction } from './order-transactions';

/** Lưu hoá đơn và các bước bền vững; mọi method kết thúc transaction trước khi caller gọi HTTP. */
@Injectable()
export class OrderStore {
  constructor(private readonly prisma: PrismaService) {}

  /** Unique key giành đúng một id qua nhiều instance; sắp mã tem để đổi thứ tự không thành nội dung khác. */
  async open(user: AuthUser, key: string, request: CreatePosOrderRequest): Promise<OrderRecord> {
    assertOrderBranch(user, request.branchId);
    const tagCodes = [...request.tagCodes].sort();
    const hashInput =
      request.customerId === undefined
        ? { branchId: request.branchId, tagCodes }
        : { branchId: request.branchId, tagCodes, customerId: request.customerId };
    const hash = createHash('sha256').update(JSON.stringify(hashInput)).digest('hex');
    try {
      return await this.insertOrder(
        user,
        key,
        hash,
        request.branchId,
        tagCodes,
        request.customerId,
      );
    } catch (error) {
      if (violatedUniqueIndex(error) !== 'Order_idempotencyKey_key') throw error;
      const existing = await this.prisma.order.findUniqueOrThrow({
        where: { idempotencyKey: key },
        include: { items: true },
      });
      assertOrderBranch(user, existing.branchId);
      if (existing.requestHash !== hash) {
        throw new BusinessError(
          'IDEMPOTENCY_KEY_REUSED',
          'Key đã được dùng cho nội dung khác',
          422,
        );
      }
      return existing;
    }
  }

  /** Tạo dòng CREATING và lịch sử đầu tiên trong một transaction; chưa phát order.created khi chưa có hàng. */
  private insertOrder(
    user: AuthUser,
    key: string,
    requestHash: string,
    branchId: string,
    tagCodes: string[],
    customerId?: string,
  ): Promise<OrderRecord> {
    return orderTransaction(this.prisma, async (transaction) => {
      if (customerId !== undefined) {
        const customer = await transaction.customer.findUnique({
          where: { id: customerId },
          select: { id: true },
        });
        if (customer === null)
          throw new BusinessError('NOT_FOUND', 'Không tìm thấy khách hàng', 404);
      }
      const order = await transaction.order.create({
        data: {
          id: randomUUID(),
          // Mã mới chỉ dùng chữ/số để VietQR dùng nguyên mã đơn làm nội dung chuyển khoản.
          code: `POS${randomUUID().replaceAll('-', '')}`,
          branchId,
          customerId,
          idempotencyKey: key,
          requestHash,
          requestedTagCodes: tagCodes,
          createdBy: user.id,
        },
        include: { items: true },
      });
      await transaction.orderStatusHistory.create({
        data: { orderId: order.id, toStatus: 'CREATING', changedBy: user.id },
      });
      return order;
    });
  }

  /** Đọc trong schema sales và kiểm quyền trên chi nhánh thật của đơn, không tin branchId client gửi. */
  async load(user: AuthUser, orderId: string): Promise<OrderRecord> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (order === null) throw new BusinessError('NOT_FOUND', 'Không tìm thấy hoá đơn', 404);
    assertOrderBranch(user, order.branchId);
    return order;
  }

  /** Tra theo key cho giao diện khôi phục sau timeout mà không tạo đơn mới. */
  async loadByKey(user: AuthUser, key: string): Promise<OrderRecord> {
    const order = await this.prisma.order.findUnique({
      where: { idempotencyKey: key },
      include: { items: true },
    });
    if (order === null) throw new BusinessError('NOT_FOUND', 'Không tìm thấy hoá đơn', 404);
    assertOrderBranch(user, order.branchId);
    return order;
  }

  /** Chọn tối đa một lô đơn đã quá lease; nhiều instance cùng thấy lô vẫn phải claim từng đơn. */
  listExpiredOperations(): Promise<{ id: string }[]> {
    return this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "sales"."Order"
      WHERE "status" IN ('CREATING', 'CANCELLING')
        AND COALESCE("operationUntil", "updatedAt" + interval '60 seconds') < now()
      ORDER BY "updatedAt" ASC LIMIT 20`;
  }

  /** Worker chỉ đọc đơn đã giành lease; không đi qua API người dùng hay bỏ qua kiểm quyền ở controller. */
  loadForRecovery(orderId: string): Promise<OrderRecord> {
    return this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    });
  }

  /** Lease UPDATE nguyên tử, dùng giờ DB; chỉ request thắng được chạy bước HTTP tiếp theo. */
  async claim(orderId: string, owner: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "sales"."Order" SET "operationOwner" = ${owner}::uuid,
        "operationUntil" = now() + interval '60 seconds', "updatedAt" = now()
      WHERE "id" = ${orderId}::uuid AND "status" IN ('CREATING', 'CANCELLING')
        AND ("operationUntil" IS NULL OR "operationUntil" < now()) RETURNING "id"`;
    return rows.length === 1;
  }

  /** Nhả lease theo đúng chủ; tiến trình cũ không được xoá quyền của tiến trình vừa tiếp quản. */
  async releaseClaim(orderId: string, owner: string): Promise<void> {
    await this.prisma.order.updateMany({
      where: { id: orderId, operationOwner: owner },
      data: { operationOwner: null, operationUntil: null },
    });
  }

  /** Đánh dấu trước HTTP deduct; sau crash phải replay deduct, không quote lại chiếc đã SOLD cho chính đơn. */
  async markDeductionStarted(orderId: string, owner: string): Promise<void> {
    const result = await this.prisma.order.updateMany({
      where: { id: orderId, status: 'CREATING', operationOwner: owner },
      data: { deductionStarted: true },
    });
    if (result.count === 0) throw orderBusy();
  }

  /** Chép giá cuối từ deduct; chốt đơn, dòng bán, lịch sử và order.created tất cả hoặc không có gì. */
  finishCreation(
    order: OrderRecord,
    owner: string,
    deducted: DeductStockResponse,
  ): Promise<OrderRecord> {
    const total = deducted.items.reduce((sum, item) => sum.plus(item.price), new Prisma.Decimal(0));
    return orderTransaction(this.prisma, async (transaction) => {
      const updated = await changeOrderStatus(
        transaction,
        order,
        'PENDING_PAYMENT',
        order.createdBy,
        { total },
        owner,
      );
      await transaction.orderItem.createMany({
        data: deducted.items.map((item) => ({
          orderId: order.id,
          jewelryItemId: item.itemId,
          tagCode: item.tagCode,
          productName: item.productName!,
          metalWeight: item.weight,
          laborFee: item.laborFee,
          metalPriceAtSale: item.metalSellPricePerChi,
          price: item.price,
          costPrice: item.costPrice,
          variantId: item.variantId,
          metalId: item.metalId,
        })),
      });
      await emitOrderEvent(transaction, updated, ROUTING_KEYS.ORDER_CREATED);
      return transaction.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true },
      });
    });
  }

  /** Giành quyền huỷ trước release; confirm-payment không thể thắng sau khi đơn vào CANCELLING. */
  beginCancellation(
    order: OrderRecord,
    actorId: string,
    failure?: OrderFailure,
    owner?: string,
  ): Promise<OrderRecord> {
    if (
      order.status !== 'PENDING_PAYMENT' &&
      !(order.status === 'CREATING' && failure !== undefined)
    ) {
      throw invalidOrderState();
    }
    return orderTransaction(this.prisma, (transaction) =>
      changeOrderStatus(
        transaction,
        order,
        'CANCELLING',
        actorId,
        failure === undefined
          ? {}
          : {
              failureCode: failure.code,
              failureHttpStatus: failure.httpStatus,
              failedTagCodes: failure.tagCodes,
            },
        owner,
      ),
    );
  }

  /** Chỉ hoàn tất huỷ sau release thành công; retry không ghi trùng lịch sử, audit hay sự kiện. */
  finishCancellation(order: OrderRecord, owner: string, actorId: string): Promise<OrderRecord> {
    return orderTransaction(this.prisma, async (transaction) => {
      const cancelled = await changeOrderStatus(
        transaction,
        order,
        'CANCELLED',
        actorId,
        {},
        owner,
      );
      await transaction.auditLog.create({
        data: { actorId, orderId: order.id, action: 'ORDER_CANCELLED' },
      });
      await emitOrderEvent(transaction, cancelled, ROUTING_KEYS.ORDER_CANCELLED);
      return cancelled;
    });
  }

  /** Hai lần xác nhận hay xác nhận đua huỷ: UPDATE trạng thái quyết định đúng một bên thắng. */
  confirmPayment(order: OrderRecord, actorId: string): Promise<OrderRecord> {
    if (order.status !== 'PENDING_PAYMENT') throw invalidOrderState();
    return orderTransaction(this.prisma, async (transaction) => {
      const completed = await changeOrderStatus(transaction, order, 'COMPLETED', actorId);
      await emitOrderEvent(transaction, completed, ROUTING_KEYS.ORDER_PAID);
      return completed;
    });
  }
}
