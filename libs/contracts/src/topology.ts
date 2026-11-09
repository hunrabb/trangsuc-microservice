/** Tên exchange/queue trong infra/rabbitmq/definitions.json. Service không tự khai báo topology. */
export const EVENTS_EXCHANGE = 'domain.events';
export const DEAD_LETTER_EXCHANGE = 'dlx';
/** Bản sao chỉ để quan sát; thư trong các DLQ gốc không bị lấy ra để hiển thị. */
export const DLQ_OBSERVER_QUEUE = 'report.dlq.observer';

export const QUEUES = {
  INVENTORY: 'inventory.events',
  SALES: 'sales.events',
  REPORT: 'report.events',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Bậc retry, theo thứ tự. Mỗi queue chính có một queue chờ cho mỗi bậc, hết TTL thì thư quay lại queue chính. */
export const RETRY_TIERS = [
  { suffix: 'retry.5s', ttlMs: 5_000 },
  { suffix: 'retry.30s', ttlMs: 30_000 },
  { suffix: 'retry.5m', ttlMs: 300_000 },
] as const;

export const retryQueueName = (queue: string, tier: number): string =>
  `${queue}.${RETRY_TIERS[tier]?.suffix}`;

export const deadLetterQueueName = (queue: string): string => `${queue}.dlq`;

/** Header trên thư. Thêm vào, không đổi tên. */
export const MESSAGE_HEADERS = {
  CORRELATION_ID: 'x-correlation-id',
  /** Số lần đã thử lại, do consumer đếm. */
  RETRY_COUNT: 'x-retry-count',
  /** `TRANSIENT` (hết lượt thử lại) hoặc `PERMANENT`. */
  ERROR_KIND: 'x-error-kind',
  ERROR_REASON: 'x-error-reason',
  /** Queue chính nơi thư bị lỗi. */
  FAILED_QUEUE: 'x-failed-queue',
  /** Routing key lúc outbox gửi lần đầu, giữ qua retry; chỉ hiển thị, không dùng để replay. */
  ORIGINAL_ROUTING_KEY: 'x-original-routing-key',
  /** ID tuỳ chọn cho nguồn ngoài; consumer chung để observer tự tạo ID ổn định từ messageId. */
  DLQ_COPY_ID: 'x-dlq-copy-id',
  /** Liên kết một lần replay với thư quay lại DLQ nếu xử lý vẫn lỗi. */
  REPLAY_ATTEMPT_ID: 'x-replay-attempt-id',
} as const;
