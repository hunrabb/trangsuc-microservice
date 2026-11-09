import { DLQ_OBSERVER_QUEUE, MESSAGE_HEADERS } from '@jewelry/contracts';
import { RabbitConnection } from '@jewelry/common';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { copyIdOf, OBSERVED_QUEUES, replayEnvelope, safeFailureReason } from './dlq-policy';

/** Nhận bản sao từ exchange DLX; chỉ ack queue observer sau khi PostgreSQL lưu xong. */
@Injectable()
export class DlqObserver implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DlqObserver.name);
  private channel?: Channel;
  private tag?: string;
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly rabbit: RabbitConnection,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.rabbit.addSetup((model) => this.subscribe(model));
  }

  /** Ngừng nhận, chờ các ghi DB đang chạy rồi mới đóng kênh. */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.channel && this.tag) await this.channel.cancel(this.tag).catch(() => undefined);
    await Promise.allSettled(this.inFlight);
    await this.channel?.close().catch(() => undefined);
  }

  private async subscribe(model: ChannelModel): Promise<void> {
    if (this.stopping) return;
    const channel = await model.createChannel();
    channel.on('error', () => this.logger.warn('Kênh quan sát DLQ bị lỗi'));
    channel.on('close', () => {
      if (!this.stopping && this.channel === channel) {
        setTimeout(() => void this.subscribe(model).catch(() => undefined), 1_000);
      }
    });
    await channel.prefetch(1);
    const { consumerTag } = await channel.consume(DLQ_OBSERVER_QUEUE, (message) => {
      if (!message) return;
      const work = this.record(message)
        .then(() => channel.ack(message))
        .catch(() => {
          this.logger.error('Không lưu được bản sao DLQ; sẽ thử lại');
          setTimeout(() => {
            try {
              channel.nack(message, false, true);
            } catch {
              /* kênh đã đóng */
            }
          }, 1_000);
        })
        .finally(() => this.inFlight.delete(work));
      this.inFlight.add(work);
    });
    this.channel = channel;
    this.tag = consumerTag;
  }

  /** Chỉ tin routing key từ broker; header và payload không được dùng để chọn queue nguồn. */
  async record(message: ConsumeMessage): Promise<void> {
    const deadLetterQueue = message.fields.routingKey;
    const sourceQueue = deadLetterQueue.endsWith('.dlq') ? deadLetterQueue.slice(0, -4) : '';
    if (!OBSERVED_QUEUES.some((queue) => queue === sourceQueue)) {
      throw new Error('Routing key DLQ chưa được quản lý');
    }
    const headers = message.properties.headers ?? {};
    const envelope = replayEnvelope(message.content, sourceQueue);
    const raw = this.safeMetadata(message.content);
    const copyId = copyIdOf(
      deadLetterQueue,
      message.content,
      message.properties.messageId,
      headers,
    );
    const replayAttemptId = z.uuid().safeParse(headers[MESSAGE_HEADERS.REPLAY_ATTEMPT_ID]);
    const retry = headers[MESSAGE_HEADERS.RETRY_COUNT];
    const originalRoutingKey = headers[MESSAGE_HEADERS.ORIGINAL_ROUTING_KEY];
    await this.prisma.$transaction(async (tx) => {
      await tx.deadLetterRecord.createMany({
        data: [
          {
            id: copyId,
            sourceQueue,
            sourceService: sourceQueue.split('.')[0] ?? '',
            routingKey:
              typeof originalRoutingKey === 'string' && /^[a-z_.]{1,80}$/.test(originalRoutingKey)
                ? originalRoutingKey
                : null,
            eventType: envelope?.eventType ?? raw.eventType,
            eventId: envelope?.eventId ?? raw.eventId,
            correlationId: envelope?.correlationId ?? raw.correlationId,
            failureKind:
              headers[MESSAGE_HEADERS.ERROR_KIND] === 'TRANSIENT'
                ? 'TRANSIENT'
                : headers[MESSAGE_HEADERS.ERROR_KIND] === 'PERMANENT'
                  ? 'PERMANENT'
                  : 'UNKNOWN',
            failureReason: safeFailureReason(headers),
            retryCount:
              typeof retry === 'number' && Number.isInteger(retry) && retry >= 0 && retry <= 3
                ? retry
                : null,
            content: Uint8Array.from(message.content),
          },
        ],
        skipDuplicates: true,
      });
      if (replayAttemptId.success) {
        await tx.dlqReplayAttempt.updateMany({
          where: { id: replayAttemptId.data, status: { in: ['REQUESTED', 'REPUBLISHED'] } },
          data: { status: 'PROCESSING_FAILED', failureCode: 'RETURNED_TO_DLQ' },
        });
      }
    });
  }

  /** Chỉ trích ID/loại sự kiện có khuôn dạng hợp lệ; không lưu object hiển thị từ payload. */
  private safeMetadata(content: Buffer): {
    eventType?: string | null;
    eventId?: string | null;
    correlationId?: string | null;
  } {
    try {
      const raw: unknown = JSON.parse(content.toString('utf8'));
      if (typeof raw !== 'object' || raw === null) return {};
      const value = raw as Record<string, unknown>;
      return {
        eventType:
          typeof value.eventType === 'string' && /^[a-z_.]{1,80}$/.test(value.eventType)
            ? value.eventType
            : null,
        eventId: z.uuid().safeParse(value.eventId).success ? String(value.eventId) : null,
        correlationId:
          typeof value.correlationId === 'string' && z.uuid().safeParse(value.correlationId).success
            ? value.correlationId
            : null,
      };
    } catch {
      return {};
    }
  }
}
