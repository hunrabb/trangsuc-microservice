import { createHash } from 'node:crypto';
import {
  EVENT_PAYLOAD_SCHEMAS,
  eventEnvelopeSchema,
  MESSAGE_HEADERS,
  QUEUES,
  ROUTING_KEYS,
  isEventType,
} from '@jewelry/contracts';
import { z } from 'zod';

const REPLAY_EVENTS: Record<string, readonly string[]> = {
  [QUEUES.INVENTORY]: [
    ROUTING_KEYS.BRANCH_CREATED,
    ROUTING_KEYS.BRANCH_UPDATED,
    ROUTING_KEYS.ORDER_CREATED,
    ROUTING_KEYS.ORDER_PAID,
    ROUTING_KEYS.ORDER_CANCELLED,
  ],
  [QUEUES.REPORT]: [
    ROUTING_KEYS.SYSTEM_TEST,
    ROUTING_KEYS.STOCK_CHANGED,
    ROUTING_KEYS.INVENTORY_SNAPSHOT_CLOSED,
    ROUTING_KEYS.ORDER_PAID,
    ROUTING_KEYS.ORDER_CANCELLED,
  ],
};

export const OBSERVED_QUEUES = [QUEUES.INVENTORY, QUEUES.SALES, QUEUES.REPORT] as const;
export const MAX_REPLAYS = 3;

/** Chỉ hiển thị nhóm lỗi, không đưa exception/raw header có thể chứa dữ liệu nhạy cảm ra API. */
export function safeFailureReason(headers: Record<string, unknown>): string {
  const reason = headers[MESSAGE_HEADERS.ERROR_REASON];
  if (typeof reason === 'string') {
    if (reason.includes('không phải JSON')) return 'Nội dung không phải JSON';
    if (reason.includes('Phong bì sai schema')) return 'Phong bì sự kiện sai cấu trúc';
    if (reason.includes('Payload sai schema')) return 'Dữ liệu sự kiện sai cấu trúc';
    if (reason.includes('Không có handler')) return 'Service chưa có bộ xử lý sự kiện';
    if (reason.includes('không có trong contracts')) return 'Loại sự kiện chưa được hỗ trợ';
  }
  if (headers[MESSAGE_HEADERS.ERROR_KIND] === undefined)
    return 'RabbitMQ đưa thư vào DLQ; không có lý do từ consumer';
  return headers[MESSAGE_HEADERS.ERROR_KIND] === 'TRANSIENT'
    ? 'Lỗi tạm thời sau các lần thử lại'
    : 'Lỗi xử lý sự kiện';
}

/** ID của bản sao RabbitMQ ổn định qua redelivery; thư cũ không có header dùng hash để chống ghi trùng. */
export function copyIdOf(
  queue: string,
  content: Buffer,
  messageId: string | undefined,
  headers: Record<string, unknown>,
): string {
  const provided = z.uuid().safeParse(headers[MESSAGE_HEADERS.DLQ_COPY_ID]);
  if (provided.success) return provided.data;
  const digest = createHash('sha256')
    .update(queue)
    .update(content)
    .update(messageId ?? '')
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Chỉ replay thư đúng schema vào event mà queue nguồn hiện có handler; không nhận destination từ client. */
export function replayEnvelope(content: Uint8Array, sourceQueue: string) {
  try {
    const parsed = eventEnvelopeSchema.safeParse(JSON.parse(Buffer.from(content).toString('utf8')));
    if (!parsed.success) return null;
    const envelope = parsed.data;
    if (!isEventType(envelope.eventType)) return null;
    if (!REPLAY_EVENTS[sourceQueue]?.includes(envelope.eventType)) return null;
    if (!EVENT_PAYLOAD_SCHEMAS[envelope.eventType].safeParse(envelope.payload).success) return null;
    return envelope;
  } catch {
    return null;
  }
}
