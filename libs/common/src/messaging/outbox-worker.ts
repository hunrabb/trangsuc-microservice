import { EVENTS_EXCHANGE, MESSAGE_HEADERS } from '@jewelry/contracts';
import { Logger } from '@nestjs/common';
import { runWithCorrelationId } from '../correlation/correlation-id';
import { OUTBOX_MAX_ATTEMPTS } from './outbox';
import {
  RabbitUnavailableError,
  type RabbitConnection,
  UnroutableMessageError,
} from './rabbit-connection';

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_BATCH_SIZE = 100;
const LOCK_SECONDS = 30;
/**
 * Chỉ gửi trong 25 giây đầu của thời gian giữ dòng. 5 giây còn lại là thời gian chờ publisher confirm
 * (`CONFIRM_TIMEOUT_MS`) của thư cuối, để dòng không hết hạn khi thư vẫn đang gửi: worker khác sẽ nhận lại và gửi trùng.
 */
const SEND_WINDOW_MS = 25_000;
const RETENTION_DAYS = 7;
const BACKOFF_UNIT_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** Thời gian nghỉ sau lần gửi lỗi thứ `attempts`: 2^attempts giây, tối đa 5 phút. */
export function outboxBackoffMs(attempts: number, unitMs: number = BACKOFF_UNIT_MS): number {
  return Math.min(2 ** attempts * unitMs, MAX_BACKOFF_MS);
}

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Phần tối thiểu của Prisma client mà worker cần. */
export interface OutboxDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

interface ClaimedRow {
  id: string;
  eventType: string;
  payload: unknown;
  correlationId: string;
  createdAt: Date | string;
  attempts: number;
}

export interface OutboxWorkerOptions {
  db: OutboxDb;
  rabbit: Pick<RabbitConnection, 'isConnected' | 'publish'>;
  /** Tên schema Postgres của service. SQL thô phải ghi rõ vì `search_path` của user không trỏ tới đó. */
  dbSchema: string;
  intervalMs?: number;
  batchSize?: number;
  /** Rút trong test. Mặc định `SEND_WINDOW_MS`. */
  sendWindowMs?: number;
  /** Rút thời gian nghỉ trong test. Mặc định 1 giây. */
  backoffUnitMs?: number;
}

/**
 * Gửi sự kiện từ bảng outbox lên RabbitMQ. Đảm bảo at-least-once: consumer chống trùng bằng `ProcessedEvent`.
 *
 * Nhận lô bằng một câu UPDATE (tự là một transaction ngắn) rồi gửi NGOÀI transaction. `SKIP LOCKED` và
 * trạng thái `PROCESSING` khiến nhiều worker không nhận trùng dòng; worker chết giữa chừng thì dòng được
 * nhận lại sau `lockedUntil`.
 */
export class OutboxWorker {
  private readonly logger = new Logger(OutboxWorker.name);
  private readonly table: string;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = true;
  private lastCleanupAt = 0;

  constructor(private readonly options: OutboxWorkerOptions) {
    if (!/^[a-z_]+$/.test(options.dbSchema)) {
      throw new Error(`Tên schema không hợp lệ: ${options.dbSchema}`);
    }
    this.table = `"${options.dbSchema}"."OutboxEvent"`;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  /** Chờ lô đang gửi xong để không bỏ dở dòng ở `PROCESSING`. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.running = this.tick()
        .catch((error: unknown) => {
          this.logger.warn(`Vòng gửi outbox lỗi: ${String(error)}`);
        })
        .finally(() => {
          if (!this.stopped) {
            this.schedule();
          }
        });
    }, this.intervalMs);
  }

  /** Một vòng: dọn nếu đến hạn, nhận lô, gửi. Mất kết nối thì không nhận lô, không đốt `attempts`. */
  async tick(): Promise<void> {
    await this.cleanupIfDue();
    if (!this.options.rabbit.isConnected) {
      return;
    }
    // Lấy mốc TRƯỚC khi nhận lô, theo đồng hồ của tiến trình này: không phụ thuộc lệch giờ với Postgres.
    const sendUntil = Date.now() + (this.options.sendWindowMs ?? SEND_WINDOW_MS);
    const rows = await this.claimBatch();
    for (const [index, row] of rows.entries()) {
      if (Date.now() >= sendUntil) {
        await this.release(rows.slice(index));
        this.logger.warn(`Gần hết thời gian giữ dòng, trả ${rows.length - index} dòng về PENDING`);
        return;
      }
      try {
        await this.send(row);
      } catch (error) {
        if (error instanceof RabbitUnavailableError) {
          // Lỗi của đường truyền, không phải của thư: trả cả phần còn lại về hàng đợi.
          await this.release(rows.slice(index));
          this.logger.warn(`Mất RabbitMQ giữa lô, trả ${rows.length - index} dòng về PENDING`);
          return;
        }
        await this.recordFailure(row, error);
      }
    }
  }

  private async send(row: ClaimedRow): Promise<void> {
    await runWithCorrelationId(row.correlationId, async () => {
      const envelope = {
        eventId: row.id,
        eventType: row.eventType,
        occurredAt: new Date(row.createdAt).toISOString(),
        correlationId: row.correlationId,
        payload: row.payload,
      };
      await this.options.rabbit.publish({
        exchange: EVENTS_EXCHANGE,
        routingKey: row.eventType,
        content: Buffer.from(JSON.stringify(envelope)),
        messageId: row.id,
        headers: { [MESSAGE_HEADERS.CORRELATION_ID]: row.correlationId },
      });
      await this.options.db.$executeRawUnsafe(
        `UPDATE ${this.table}
         SET status = 'PUBLISHED', "publishedAt" = now(), "lockedUntil" = NULL, "updatedAt" = now()
         WHERE id = $1::uuid AND status = 'PROCESSING'`,
        row.id,
      );
      this.logger.log(`Đã gửi sự kiện ${row.eventType} ${row.id}`);
    });
  }

  private claimBatch(): Promise<ClaimedRow[]> {
    return this.options.db.$queryRawUnsafe<ClaimedRow[]>(
      `UPDATE ${this.table}
       SET status = 'PROCESSING', "lockedUntil" = now() + interval '${LOCK_SECONDS} seconds', "updatedAt" = now()
       WHERE id IN (
         SELECT id FROM ${this.table}
         WHERE (status = 'PENDING' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now()))
            OR (status = 'PROCESSING' AND "lockedUntil" < now())
         ORDER BY "createdAt"
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, "eventType", payload, "correlationId", "createdAt", attempts`,
      this.batchSize,
    );
  }

  private async release(rows: ClaimedRow[]): Promise<void> {
    await this.options.db.$executeRawUnsafe(
      `UPDATE ${this.table}
       SET status = 'PENDING', "lockedUntil" = NULL, "updatedAt" = now()
       WHERE id = ANY($1::uuid[]) AND status = 'PROCESSING'`,
      rows.map((row) => row.id),
    );
  }

  private async recordFailure(row: ClaimedRow, error: unknown): Promise<void> {
    const delayMs = outboxBackoffMs(row.attempts + 1, this.options.backoffUnitMs);
    const failed = await this.options.db.$queryRawUnsafe<{ status: string; attempts: number }[]>(
      `UPDATE ${this.table}
       SET attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= $2 THEN 'FAILED'::"${this.options.dbSchema}"."OutboxStatus"
                         ELSE 'PENDING'::"${this.options.dbSchema}"."OutboxStatus" END,
           "nextAttemptAt" = CASE WHEN attempts + 1 >= $2 THEN NULL
                                  ELSE now() + ($3::double precision * interval '1 millisecond') END,
           "lockedUntil" = NULL,
           "updatedAt" = now()
       WHERE id = $1::uuid AND status = 'PROCESSING'
       RETURNING status, attempts`,
      row.id,
      OUTBOX_MAX_ATTEMPTS,
      delayMs,
    );
    await runWithCorrelationId(row.correlationId, async () => {
      const detail = `sự kiện ${row.eventType} ${row.id} (lần ${failed[0]?.attempts}): ${String(error)}`;
      if (error instanceof UnroutableMessageError) {
        this.logger.error(
          `Không queue nào nhận ${detail}. Kiểm tra binding của routing key "${row.eventType}" trong infra/rabbitmq/definitions.json`,
        );
      }
      if (failed[0]?.status === 'FAILED') {
        this.logger.error(`Dừng gửi ${detail}. Sửa lỗi rồi chạy outbox:requeue (xem README)`);
      } else if (!(error instanceof UnroutableMessageError)) {
        this.logger.warn(`Gửi lỗi, sẽ thử lại ${detail}`);
      }
    });
  }

  /** Không để lỗi dọn dẹp cản việc gửi. */
  private async cleanupIfDue(): Promise<void> {
    if (Date.now() - this.lastCleanupAt < CLEANUP_INTERVAL_MS) {
      return;
    }
    this.lastCleanupAt = Date.now();
    await this.cleanup().catch((error: unknown) => {
      this.logger.warn(`Dọn outbox lỗi: ${String(error)}`);
    });
  }

  /** Xoá dòng `PUBLISHED` cũ. Trả về số dòng đã xoá. */
  cleanup(): Promise<number> {
    return this.options.db.$executeRawUnsafe(
      `DELETE FROM ${this.table}
       WHERE status = 'PUBLISHED' AND "publishedAt" < now() - interval '${RETENTION_DAYS} days'`,
    );
  }
}
