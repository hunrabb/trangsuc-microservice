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
} as const;

export const systemTestPayloadSchema = z.object({ message: z.string().max(200) });

export type SystemTestPayload = z.infer<typeof systemTestPayloadSchema>;

/** Sự kiện nào có schema payload nào. Thêm sự kiện mới = thêm một dòng ở đây. */
export const EVENT_PAYLOAD_SCHEMAS = {
  [ROUTING_KEYS.SYSTEM_TEST]: systemTestPayloadSchema,
} as const;

export type EventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[T]>;

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_PAYLOAD_SCHEMAS, value);
}
