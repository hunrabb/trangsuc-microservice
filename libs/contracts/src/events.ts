import { z } from 'zod';

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
  BRANCH_CREATED: 'branch.created',
  BRANCH_UPDATED: 'branch.updated',
  METAL_PRICE_CHANGED: 'metal_price.changed',
  STOCK_CHANGED: 'stock.changed',
  ORDER_CREATED: 'order.created',
  ORDER_PAID: 'order.paid',
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

/** Sự kiện nào có schema payload nào. Thêm sự kiện mới = thêm một dòng ở đây. */
export const EVENT_PAYLOAD_SCHEMAS = {
  [ROUTING_KEYS.SYSTEM_TEST]: systemTestPayloadSchema,
  [ROUTING_KEYS.BRANCH_CREATED]: branchCreatedPayloadSchema,
  [ROUTING_KEYS.BRANCH_UPDATED]: branchUpdatedPayloadSchema,
  [ROUTING_KEYS.METAL_PRICE_CHANGED]: metalPriceChangedPayloadSchema,
  [ROUTING_KEYS.STOCK_CHANGED]: stockChangedPayloadSchema,
  [ROUTING_KEYS.ORDER_CREATED]: posOrderEventPayloadSchema,
  [ROUTING_KEYS.ORDER_PAID]: posOrderEventPayloadSchema,
  [ROUTING_KEYS.ORDER_CANCELLED]: posOrderEventPayloadSchema,
} as const;

export type EventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[T]>;

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_PAYLOAD_SCHEMAS, value);
}
