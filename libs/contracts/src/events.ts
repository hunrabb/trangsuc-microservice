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

/** Sự kiện nào có schema payload nào. Thêm sự kiện mới = thêm một dòng ở đây. */
export const EVENT_PAYLOAD_SCHEMAS = {
  [ROUTING_KEYS.SYSTEM_TEST]: systemTestPayloadSchema,
  [ROUTING_KEYS.BRANCH_CREATED]: branchCreatedPayloadSchema,
  [ROUTING_KEYS.BRANCH_UPDATED]: branchUpdatedPayloadSchema,
} as const;

export type EventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[T]>;

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_PAYLOAD_SCHEMAS, value);
}
