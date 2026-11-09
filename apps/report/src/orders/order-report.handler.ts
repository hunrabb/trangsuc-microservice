import { onlineOrderCancelledSchema } from '@jewelry/contracts';
import { PermanentError } from '@jewelry/common';
import {
  type EventEnvelope,
  type OrderPaidPayload,
  orderPaidPayloadSchema,
  posOrderEventPayloadSchema,
} from '@jewelry/contracts';
import {
  Prisma,
  type Prisma as PrismaTypes,
  type OrderRevenue,
  type OrderLineSales,
} from '../generated/prisma/client';

type Context = { tx: PrismaTypes.TransactionClient; envelope: EventEnvelope };

/** Ngày báo cáo theo giờ Việt Nam, độc lập với timezone của máy chạy service. */
export function vietnamDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

/** Dùng chung cho live, dry-run và import; không chấp nhận tiền âm hoặc snapshot không khớp. */
export function validatePaidOrder(payload: unknown): OrderPaidPayload {
  const parsed = orderPaidPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new PermanentError('Sự kiện order.paid không hợp lệ');
  const order = parsed.data;
  const money = /^(0|[1-9]\d{0,12})(\.\d{1,2})?$/;
  const weight = /^(0|[1-9]\d{0,7})(\.\d{1,4})?$/;
  if (
    !money.test(order.total) ||
    order.items.some(
      (line) =>
        !money.test(line.price) ||
        !weight.test(line.metalWeight) ||
        (line.costPrice !== null && !money.test(line.costPrice)),
    )
  ) {
    throw new PermanentError('Snapshot order.paid có số thập phân không hợp lệ');
  }
  if (new Set(order.items.map((line) => line.tagCode)).size !== order.items.length) {
    throw new PermanentError('Sự kiện order.paid có mã tem trùng');
  }
  const total = order.items.reduce((sum, line) => sum.plus(line.price), new Prisma.Decimal(0));
  if (!total.equals(order.total))
    throw new PermanentError('Tổng tiền order.paid không khớp dòng bán');
  const cost = order.items.reduce(
    (sum, line) => sum.plus(line.costPrice ?? '0'),
    new Prisma.Decimal(0),
  );
  if (cost.greaterThan('9999999999999.99')) {
    throw new PermanentError('Tổng giá vốn vượt giới hạn lưu trữ báo cáo');
  }
  if (
    JSON.stringify([...order.tagCodes].sort()) !==
    JSON.stringify(order.items.map((line) => line.tagCode).sort())
  ) {
    throw new PermanentError('Danh sách tem order.paid không khớp dòng bán');
  }
  return order;
}

/** So sánh mọi dữ liệu đóng góp vào báo cáo; không sửa bản ghi cũ khi phát hiện khác biệt. */
export function paidOrderMatches(
  stored: OrderRevenue & { lines: OrderLineSales[] },
  order: OrderPaidPayload,
): boolean {
  const cogs = order.items.every((line) => line.costPrice !== null)
    ? order.items.reduce((sum, line) => sum.plus(line.costPrice!), new Prisma.Decimal(0))
    : null;
  return (
    stored.status === 'PAID' &&
    stored.branchId === order.branchId &&
    stored.channel === order.channel &&
    stored.localDate === vietnamDate(new Date(order.paidAt)) &&
    stored.revenue.equals(order.total) &&
    (cogs === null ? stored.cogs === null : stored.cogs?.equals(cogs) === true) &&
    stored.lines.length === order.items.length &&
    order.items.every((line) => {
      const old = stored.lines.find((item) => item.tagCode === line.tagCode);
      return (
        old !== undefined &&
        old.variantId === line.variantId &&
        old.metalId === line.metalId &&
        old.productName === line.productName &&
        old.metalWeight.equals(line.metalWeight) &&
        old.revenue.equals(line.price) &&
        (line.costPrice === null ? old.cogs === null : old.cogs?.equals(line.costPrice) === true)
      );
    })
  );
}

/** Ghi snapshot đơn đã thu tiền; unique orderId chặn cả live/backfill chạy đồng thời. */
export async function recordPaidOrder(
  payload: unknown,
  { tx }: Context,
): Promise<'CREATED' | 'EXISTS' | 'CANCELLED'> {
  const order = validatePaidOrder(payload);
  const total = new Prisma.Decimal(order.total);
  const cogs = order.items.every((line) => line.costPrice !== null)
    ? order.items.reduce((sum, line) => sum.plus(line.costPrice!), new Prisma.Decimal(0))
    : null;
  const paidAt = new Date(order.paidAt);
  // Hai eventId khác nhau có thể tới cùng lúc: ON CONFLICT chờ transaction thắng,
  // tránh P2002 bị consumer phân loại thành lỗi vĩnh viễn rồi đẩy vào DLQ.
  const inserted = await tx.orderRevenue.createMany({
    data: [
      {
        orderId: order.orderId,
        branchId: order.branchId,
        channel: order.channel,
        localDate: vietnamDate(paidAt),
        paidAt,
        revenue: total,
        cogs,
        status: 'PAID',
      },
    ],
    skipDuplicates: true,
  });
  const revenue = await tx.orderRevenue.findUniqueOrThrow({
    where: { orderId: order.orderId },
    include: { lines: true },
  });
  if (revenue.status === 'CANCELLED') return 'CANCELLED';
  if (inserted.count === 0) {
    if (paidOrderMatches(revenue, order)) return 'EXISTS';
    throw new PermanentError('Sự kiện order.paid mâu thuẫn với đơn đã ghi');
  }
  await tx.orderLineSales.createMany({
    data: order.items.map((line) => ({
      orderId: order.orderId,
      tagCode: line.tagCode,
      variantId: line.variantId,
      metalId: line.metalId,
      productName: line.productName,
      metalWeight: line.metalWeight,
      revenue: line.price,
      cogs: line.costPrice,
    })),
    skipDuplicates: true,
  });
  return 'CREATED';
}

/** Huỷ tạo dấu chặn nếu đến trước paid; không xoá doanh thu đã thu tiền vì POS không hoàn tiền ở Phase 5. */
export async function recordCancelledOrder(
  payload: unknown,
  { tx, envelope }: Context,
): Promise<void> {
  // Huỷ đơn online chưa thu tiền không đóng góp doanh thu POS.
  if (onlineOrderCancelledSchema.safeParse(payload).success) return;
  const parsed = posOrderEventPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new PermanentError('Sự kiện order.cancelled không hợp lệ');
  const order = parsed.data;
  await tx.orderRevenue.createMany({
    data: [
      {
        orderId: order.orderId,
        branchId: order.branchId,
        channel: order.channel,
        localDate: vietnamDate(new Date(envelope.occurredAt)),
        revenue: '0',
        cogs: '0',
        status: 'CANCELLED',
      },
    ],
    skipDuplicates: true,
  });
}
