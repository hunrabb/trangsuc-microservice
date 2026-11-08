import { type AuthUser, BusinessError } from '@jewelry/common';
import { type ErrorCode, errorCodeSchema, type PosOrder } from '@jewelry/contracts';
import type { Prisma } from '../generated/prisma/client';

export type OrderRecord = Prisma.OrderGetPayload<{ include: { items: true } }>;
export type Transaction = Prisma.TransactionClient;
export interface OrderFailure {
  code: ErrorCode;
  httpStatus: number;
  tagCodes: string[];
}

/** Lọc theo chi nhánh lấy từ token; ADMIN toàn hệ thống là ngoại lệ chung của dự án. */
export function assertOrderBranch(user: AuthUser, branchId: string): void {
  const allowed = user.branches.some(
    (assignment) =>
      (assignment.role === 'ADMIN' && assignment.branchId === null) ||
      (assignment.branchId === branchId && ['STAFF', 'MANAGER'].includes(assignment.role)),
  );
  if (!allowed) throw new BusinessError('FORBIDDEN', 'Không có quyền tại chi nhánh này', 403);
}

/** Chỉ trả snapshot công khai của hoá đơn; không lộ key, hash hay lease xử lý nội bộ. */
export function presentOrder(order: OrderRecord): PosOrder {
  return {
    id: order.id,
    code: order.code,
    branchId: order.branchId,
    status: order.status,
    total: order.total.toFixed(2),
    version: order.version,
    items: order.items.map((item) => ({
      id: item.id,
      tagCode: item.tagCode,
      productName: item.productName,
      metalWeight: item.metalWeight.toFixed(4),
      laborFee: item.laborFee.toFixed(2),
      stoneFee: item.stoneFee.toFixed(2),
      metalPriceAtSale: item.metalPriceAtSale.toFixed(2),
      price: item.price.toFixed(2),
    })),
  };
}

/** Lưu lỗi để cùng key gọi lại vẫn nhận đúng kết quả; lỗi hạ tầng không bị đổi thành hết hàng. */
export function creationFailure(error: unknown, tagCodes: string[]): OrderFailure {
  if (error instanceof BusinessError) {
    const failedTags = error.details?.tagCodes;
    return {
      code: error.code,
      httpStatus: error.httpStatus,
      tagCodes: Array.isArray(failedTags)
        ? failedTags.filter((tag) => typeof tag === 'string')
        : tagCodes,
    };
  }
  return { code: 'SERVICE_UNAVAILABLE', httpStatus: 503, tagCodes };
}

/** Đơn tạo thất bại giữ CANCELLED và không có dòng bán; mọi lần phát lại trả cùng lỗi đã lưu. */
export function throwCreationFailure(order: OrderRecord): void {
  if (order.failureCode === null) return;
  throw new BusinessError(
    errorCodeSchema.parse(order.failureCode),
    'Không thể tạo hoá đơn, hàng đã được giải phóng',
    order.failureHttpStatus ?? 503,
    { orderId: order.id, tagCodes: order.failedTagCodes },
  );
}

export const invalidOrderState = () =>
  new BusinessError('INVALID_STATE', 'Trạng thái hoá đơn không cho phép thao tác này', 409);

export const orderBusy = () =>
  new BusinessError('SERVICE_UNAVAILABLE', 'Hoá đơn đang xử lý, hãy gửi lại cùng key', 503);
