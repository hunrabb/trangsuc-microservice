import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  deadLetterQueueName,
  EVENT_PAYLOAD_SCHEMAS,
  type EventEnvelope,
  eventEnvelopeSchema,
  isEventType,
  MESSAGE_HEADERS,
  RETRY_TIERS,
  retryQueueName,
} from '@jewelry/contracts';
import { Logger } from '@nestjs/common';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { runWithCorrelationId } from '../correlation/correlation-id';
import {
  classifyError,
  type ErrorKind,
  isDuplicateProcessedEvent,
  PermanentError,
} from './message-errors';
import { RabbitConnection } from './rabbit-connection';

/** Phải nhỏ hơn `connection_limit` của Prisma: mỗi thư đang xử lý chiếm một kết nối DB. */
export const CONSUMER_PREFETCH = 10;

const REQUEUE_DELAY_MS = 1_000;
/** Header RabbitMQ tự thêm khi dead-letter. Bỏ đi khi gửi bản sao để không chồng dồn qua các lần thử. */
const BROKER_HEADERS = /^x-(death|first-death-|last-death-)/;

/** Phần tối thiểu của `tx` trong `prisma.$transaction`. */
export interface ConsumerTx {
  processedEvent: {
    create(args: { data: { eventId: string; consumer: string } }): Promise<unknown>;
  };
}

export interface ConsumerDb<Tx extends ConsumerTx = ConsumerTx> {
  $transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

/**
 * Xử lý một sự kiện trong transaction của consumer. Kết quả nghiệp vụ (ví dụ hết hàng) KHÔNG ném lỗi:
 * handler tự ghi outbox sự kiện kết quả. Không gọi HTTP hay RabbitMQ trong handler.
 */
export type EventHandler<Tx extends ConsumerTx = ConsumerTx> = (
  payload: never,
  context: { tx: Tx; envelope: EventEnvelope },
) => Promise<void>;

export interface EventConsumerOptions<Tx extends ConsumerTx = ConsumerTx> {
  rabbit: RabbitConnection;
  db: ConsumerDb<Tx>;
  /** Queue chính, có sẵn trong definitions.json. */
  queue: string;
  /** Tên consumer, là một phần khoá của `ProcessedEvent`. */
  consumer: string;
  handlers: Partial<Record<string, EventHandler<Tx>>>;
  /** Chỉ dùng trong test: rút thời gian chờ từng bậc bằng `expiration` của thư. */
  retryExpirationMs?: readonly number[];
}

interface ParsedMessage {
  envelope: EventEnvelope;
  payload: unknown;
  handler: EventHandler<never>;
}

/**
 * Consumer cơ sở. Chỉ subscribe queue có sẵn, manual ack.
 *
 * Thứ tự an toàn của mỗi thư: commit DB (hoặc gửi bản sao vào queue chờ/DLQ và chờ confirm), RỒI mới ack.
 * Sập ở giữa thì thư được giao lại, và `ProcessedEvent` đảm bảo handler không chạy lần hai.
 */
export class EventConsumer<Tx extends ConsumerTx = ConsumerTx> {
  private readonly logger: Logger;
  private channel?: Channel;
  private consumerTag?: string;
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly options: EventConsumerOptions<Tx>) {
    this.logger = new Logger(`EventConsumer:${options.queue}`);
  }

  async start(): Promise<void> {
    await this.options.rabbit.addSetup((model) => this.subscribe(model));
  }

  /** Ngừng nhận thư mới rồi chờ các thư đang xử lý xong. */
  async stop(): Promise<void> {
    this.stopping = true;
    const channel = this.channel;
    if (channel !== undefined && this.consumerTag !== undefined) {
      await channel.cancel(this.consumerTag).catch(() => undefined);
    }
    await Promise.allSettled(this.inFlight);
    await channel?.close().catch(() => undefined);
  }

  private async subscribe(model: ChannelModel): Promise<void> {
    if (this.stopping) {
      return;
    }
    const channel = await model.createChannel();
    channel.on('error', (error: Error) => {
      this.logger.warn(`Lỗi kênh consumer: ${error.message}`);
    });
    channel.on('close', () => {
      if (this.channel !== channel || this.stopping) {
        return;
      }
      // Kênh đóng riêng lẻ khi kết nối còn sống: tự mở lại. Mất cả kết nối thì `recovery` lo.
      setTimeout(() => {
        this.subscribe(model).catch((error: unknown) => {
          this.logger.warn(`Chưa mở lại được kênh consumer: ${String(error)}`);
        });
      }, RabbitConnection.channelReopenDelayMs);
    });
    await channel.prefetch(CONSUMER_PREFETCH);
    const { consumerTag } = await channel.consume(
      this.options.queue,
      (message) => {
        if (message !== null) {
          const work = this.handle(channel, message)
            .catch((error: unknown) => {
              // Không ack: thư sẽ được giao lại khi kênh đóng.
              this.logger.error(`Không xử lý xong thư: ${String(error)}`);
            })
            .finally(() => this.inFlight.delete(work));
          this.inFlight.add(work);
        }
      },
      { noAck: false },
    );
    this.channel = channel;
    this.consumerTag = consumerTag;
  }

  private correlationIdOf(message: ConsumeMessage): string {
    const header = message.properties.headers?.[MESSAGE_HEADERS.CORRELATION_ID] as unknown;
    return typeof header === 'string' && header !== '' ? header : randomUUID();
  }

  private async handle(channel: Channel, message: ConsumeMessage): Promise<void> {
    let parsed: ParsedMessage;
    try {
      parsed = this.parse(message);
    } catch (error) {
      const correlationId = this.correlationIdOf(message);
      await runWithCorrelationId(correlationId, () =>
        this.sendToDeadLetter(channel, message, correlationId, 'PERMANENT', error),
      );
      return;
    }
    const { correlationId } = parsed.envelope;
    await runWithCorrelationId(correlationId, async () => {
      try {
        await this.process(parsed);
      } catch (error) {
        await this.onFailure(channel, message, parsed.envelope, error);
        return;
      }
      this.options.rabbit.ack(channel as never, message);
      this.logger.log(`Đã xử lý sự kiện ${parsed.envelope.eventType} ${parsed.envelope.eventId}`);
    });
  }

  /** Sai cấu trúc, sai schema hoặc không có handler: thử lại cũng vô ích. */
  private parse(message: ConsumeMessage): ParsedMessage {
    let raw: unknown;
    try {
      raw = JSON.parse(message.content.toString('utf8'));
    } catch {
      throw new PermanentError('Nội dung thư không phải JSON');
    }
    const envelope = eventEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      throw new PermanentError(`Phong bì sai schema: ${envelope.error.message}`);
    }
    const { eventType } = envelope.data;
    if (!isEventType(eventType)) {
      throw new PermanentError(`Sự kiện không có trong contracts: ${eventType}`);
    }
    const payload = EVENT_PAYLOAD_SCHEMAS[eventType].safeParse(envelope.data.payload);
    if (!payload.success) {
      throw new PermanentError(`Payload sai schema: ${payload.error.message}`);
    }
    const handler = this.options.handlers[eventType];
    if (handler === undefined) {
      throw new PermanentError(`Không có handler cho sự kiện ${eventType}`);
    }
    return {
      envelope: envelope.data,
      payload: payload.data,
      handler: handler as unknown as EventHandler<never>,
    };
  }

  /** Ghi `ProcessedEvent` TRƯỚC: thư trùng dừng ngay tại đó, handler không chạy. */
  private process({ envelope, payload, handler }: ParsedMessage): Promise<void> {
    return this.options.db.$transaction(async (tx) => {
      await tx.processedEvent.create({
        data: { eventId: envelope.eventId, consumer: this.options.consumer },
      });
      await (handler as unknown as EventHandler<Tx>)(payload as never, { tx, envelope });
    });
  }

  private async onFailure(
    channel: Channel,
    message: ConsumeMessage,
    envelope: EventEnvelope,
    error: unknown,
  ): Promise<void> {
    if (isDuplicateProcessedEvent(error)) {
      this.options.rabbit.ack(channel as never, message);
      this.logger.log(`Bỏ qua sự kiện đã xử lý ${envelope.eventType} ${envelope.eventId}`);
      return;
    }
    const kind = classifyError(error);
    const retries = this.retryCountOf(message);
    if (kind === 'TRANSIENT' && retries < RETRY_TIERS.length) {
      await this.sendToRetry(channel, message, envelope, retries, error);
    } else {
      await this.sendToDeadLetter(channel, message, envelope.correlationId, kind, error);
    }
  }

  private retryCountOf(message: ConsumeMessage): number {
    const value = message.properties.headers?.[MESSAGE_HEADERS.RETRY_COUNT] as unknown;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
  }

  /** Giữ nguyên nội dung và header của thư gốc, chỉ bỏ header do broker thêm. */
  private copyHeaders(
    message: ConsumeMessage,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    const kept = Object.entries(message.properties.headers ?? {}).filter(
      ([name]) => !BROKER_HEADERS.test(name),
    );
    return { ...Object.fromEntries(kept), ...extra };
  }

  private async sendToRetry(
    channel: Channel,
    message: ConsumeMessage,
    envelope: EventEnvelope,
    retries: number,
    error: unknown,
  ): Promise<void> {
    const queue = retryQueueName(this.options.queue, retries);
    await this.forward(channel, message, {
      routingKey: queue,
      exchange: '',
      headers: this.copyHeaders(message, {
        [MESSAGE_HEADERS.CORRELATION_ID]: envelope.correlationId,
        [MESSAGE_HEADERS.RETRY_COUNT]: retries + 1,
      }),
      expirationMs: this.options.retryExpirationMs?.[retries],
    });
    this.logger.warn(
      `Lỗi tạm thời, thử lại lần ${retries + 1} qua ${queue}: ${envelope.eventType} ${envelope.eventId}: ${String(error)}`,
    );
  }

  private async sendToDeadLetter(
    channel: Channel,
    message: ConsumeMessage,
    correlationId: string,
    kind: ErrorKind,
    error: unknown,
  ): Promise<void> {
    const queue = deadLetterQueueName(this.options.queue);
    await this.forward(channel, message, {
      routingKey: queue,
      exchange: '',
      headers: this.copyHeaders(message, {
        [MESSAGE_HEADERS.CORRELATION_ID]: correlationId,
        [MESSAGE_HEADERS.ERROR_KIND]: kind,
        [MESSAGE_HEADERS.ERROR_REASON]: String(error).slice(0, 1000),
        [MESSAGE_HEADERS.FAILED_QUEUE]: this.options.queue,
      }),
    });
    this.logger.error(
      `Thư vào DLQ ${queue} (${kind}), messageId=${message.properties.messageId}: ${String(error)}`,
    );
  }

  /** Gửi bản sao, chờ confirm, RỒI mới ack thư gốc. Gửi lỗi thì trả thư gốc về queue để xử lý lại. */
  private async forward(
    channel: Channel,
    message: ConsumeMessage,
    target: {
      exchange: string;
      routingKey: string;
      headers: Record<string, unknown>;
      expirationMs?: number;
    },
  ): Promise<void> {
    try {
      await this.options.rabbit.publish({
        ...target,
        content: message.content,
        messageId: message.properties.messageId ?? randomUUID(),
      });
    } catch (error) {
      this.logger.warn(`Không gửi được bản sao, trả thư về queue: ${String(error)}`);
      await sleep(REQUEUE_DELAY_MS);
      channel.nack(message, false, true);
      return;
    }
    this.options.rabbit.ack(channel as never, message);
  }
}
