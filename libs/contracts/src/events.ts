import { onlineOrderPaidSchema, paymentInventoryResultSchema } from './online-payment';
import {
  onlineOrderCreatedSchema,
  onlineOrderCancelledSchema,
  stockReservedSchema,
  stockReserveFailedSchema,
  stockReservationExpiredSchema,
} from './online-checkout';
import { z } from 'zod';
import { productSnapshotSchema, availabilitySnapshotSchema } from './shop-api';

/** Phong bì chung của mọi thư trên RabbitMQ. `eventId` = id dòng outbox. */
export const eventEnvelopeSchema = z.object({
  eventId: z.uuid(),
  eventType: z.string().min(1),
  occurredAt: z.iso.datetime(),
  correlationId: z.string().min(1),
  payload: z.unknown(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** Routing key trùng tên sự kiện. Binding tương ứng nằm trong infra/rabbitmq/definitions.json. */
export const ROUTING_KEYS = {
  /** Sự kiện kỹ thuật, CHỈ để kiểm thử đường đi outbox → consumer. Không có ý nghĩa nghiệp vụ. */
  SYSTEM_TEST: 'system.test',
  PRODUCT_SNAPSHOT: 'product.snapshot',
  STOCK_AVAILABILITY_CHANGED: 'stock.availability_changed',
  BRANCH_CREATED: 'branch.created',
  BRANCH_UPDATED: 'branch.updated',
  METAL_PRICE_CHANGED: 'metal_price.changed',
  STOCK_CHANGED: 'stock.changed',
  INVENTORY_SNAPSHOT_CLOSED: 'inventory.snapshot.closed',
  STOCK_RESERVED: 'stock.reserved',
  STOCK_RESERVE_FAILED: 'stock.reserve_failed',
  STOCK_RESERVATION_EXPIRED: 'stock.reservation_expired',
  ORDER_CREATED: 'order.created',
  ORDER_PAID: 'order.paid',
  STOCK_PAYMENT_RESULT: 'stock.payment_result',
  ORDER_CANCELLED: 'order.cancelled',
} as const;

export const systemTestPayloadSchema = z.object({ message: z.string().max(200) });

export type SystemTestPayload = z.infer<typeof systemTestPayloadSchema>;

export const branchCreatedPayloadSchema = z.object({
  branchId: z.uuid(),
  code: z.string().min(1),
  name: z.string().min(1),
});

export type BranchCreatedPayload = z.infer<typeof branchCreatedPayloadSchema>;

/** Phát cả khi ngừng hoạt động chi nhánh, nên có `isActive`. */
export const branchUpdatedPayloadSchema = branchCreatedPayloadSchema.extend({
  isActive: z.boolean(),
});

export type BranchUpdatedPayload = z.infer<typeof branchUpdatedPayloadSchema>;

/** Giá kim loại mới (đồng / chỉ, chuỗi số thập phân). `effectiveFrom` có thể ở tương lai. */
export const metalPriceChangedPayloadSchema = z.object({
  metalId: z.uuid(),
  metalCode: z.string().min(1),
  buyPrice: z.string().min(1),
  sellPrice: z.string().min(1),
  effectiveFrom: z.iso.datetime(),
});

export type MetalPriceChangedPayload = z.infer<typeof metalPriceChangedPayloadSchema>;

/**
 * Tồn kho đổi do một đơn: `SOLD` khi trừ kho, `RELEASED` khi trả hàng về kho. Mỗi lần xử lý một đơn phát ĐÚNG MỘT
 * sự kiện; gọi lại trùng không phát thêm.
 */
export const stockChangedPayloadSchema = z.object({
  orderId: z.uuid(),
  branchId: z.uuid(),
  reason: z.enum(['SOLD', 'RELEASED']),
  tagCodes: z.array(z.string().min(1)).min(1),
});

export type StockChangedPayload = z.infer<typeof stockChangedPayloadSchema>;

/** Chốt kho theo từng biến thể; tiền là giá vốn, trọng lượng tính bằng chỉ. */
export const inventorySnapshotClosedPayloadSchema = z.object({
  closeId: z.uuid(),
  localDate: z.iso.date(),
  warehouseId: z.uuid(),
  branchId: z.uuid(),
  capturedAt: z.iso.datetime(),
  previousCapturedAt: z.iso.datetime().nullable(),
  rows: z.array(
    z.object({
      variantId: z.uuid(),
      sku: z.string(),
      metalId: z.uuid(),
      metalCode: z.string(),
      metalKind: z.enum(['GOLD', 'SILVER']),
      onHand: z.number().int().nonnegative(),
      weight: z.string(),
      value: z.string(),
      received: z.number().int().nonnegative(),
      receivedWeight: z.string(),
      receivedValue: z.string(),
      released: z.number().int().nonnegative(),
      releasedWeight: z.string(),
      releasedValue: z.string(),
      sold: z.number().int().nonnegative(),
      soldWeight: z.string(),
      soldValue: z.string(),
    }),
  ),
});

export type InventorySnapshotClosedPayload = z.infer<typeof inventorySnapshotClosedPayloadSchema>;

/** POS đã trừ kho qua HTTP; consumer phải xem channel trước khi xử lý giữ hàng online. */
export const posOrderEventPayloadSchema = z.object({
  orderId: z.uuid(),
  branchId: z.uuid(),
  channel: z.literal('POS'),
  code: z.string().min(1),
  total: z.string().min(1),
  tagCodes: z.array(z.string().min(1)).min(1),
});

export type PosOrderEventPayload = z.infer<typeof posOrderEventPayloadSchema>;

/** Snapshot bất biến của POS khi đã nhận tiền; Report không truy vấn chéo schema. */
export const orderPaidPayloadSchema = posOrderEventPayloadSchema.extend({
  paidAt: z.iso.datetime(),
  items: z
    .array(
      z.object({
        tagCode: z.string().min(1),
        variantId: z.uuid().nullable(),
        metalId: z.uuid().nullable(),
        productName: z.string().min(1),
        metalWeight: z.string(),
        price: z.string(),
        costPrice: z.string().nullable(),
      }),
    )
    .min(1),
});

export type OrderPaidPayload = z.infer<typeof orderPaidPayloadSchema>;

/** Sự kiện nào có schema payload nào. Thêm sự kiện mới = thêm một dòng ở đây. */
export const EVENT_PAYLOAD_SCHEMAS = {
  [ROUTING_KEYS.PRODUCT_SNAPSHOT]: productSnapshotSchema,
  [ROUTING_KEYS.STOCK_AVAILABILITY_CHANGED]: availabilitySnapshotSchema,
  [ROUTING_KEYS.SYSTEM_TEST]: systemTestPayloadSchema,
  [ROUTING_KEYS.BRANCH_CREATED]: branchCreatedPayloadSchema,
  [ROUTING_KEYS.BRANCH_UPDATED]: branchUpdatedPayloadSchema,
  [ROUTING_KEYS.METAL_PRICE_CHANGED]: metalPriceChangedPayloadSchema,
  [ROUTING_KEYS.STOCK_CHANGED]: stockChangedPayloadSchema,
  [ROUTING_KEYS.INVENTORY_SNAPSHOT_CLOSED]: inventorySnapshotClosedPayloadSchema,
  [ROUTING_KEYS.ORDER_CREATED]: z.union([posOrderEventPayloadSchema, onlineOrderCreatedSchema]),
  [ROUTING_KEYS.ORDER_PAID]: z.union([orderPaidPayloadSchema, onlineOrderPaidSchema]),
  [ROUTING_KEYS.STOCK_PAYMENT_RESULT]: paymentInventoryResultSchema,
  [ROUTING_KEYS.ORDER_CANCELLED]: z.union([posOrderEventPayloadSchema, onlineOrderCancelledSchema]),
  [ROUTING_KEYS.STOCK_RESERVED]: stockReservedSchema,
  [ROUTING_KEYS.STOCK_RESERVE_FAILED]: stockReserveFailedSchema,
  [ROUTING_KEYS.STOCK_RESERVATION_EXPIRED]: stockReservationExpiredSchema,
} as const;

export type EventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[T]>;

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_PAYLOAD_SCHEMAS, value);
}
