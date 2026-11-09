import { randomUUID } from 'node:crypto';
import { BusinessError, RabbitConnection, UnroutableMessageError } from '@jewelry/common';
import { EVENTS_EXCHANGE, MESSAGE_HEADERS } from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_REPLAYS, replayEnvelope } from './dlq-policy';

const filtersSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  service: z.enum(['inventory', 'sales', 'report']).optional(),
  eventType: z
    .string()
    .regex(/^[a-z_.]{1,80}$/)
    .optional(),
  status: z
    .enum([
      'REQUESTED',
      'REPUBLISHED',
      'PUBLISH_FAILED',
      'PUBLISH_UNCONFIRMED',
      'PROCESSING_FAILED',
    ])
    .optional(),
});

const invalid = () =>
  new BusinessError('INVALID_DLQ_REQUEST', 'Bộ lọc hoặc mã thư không hợp lệ', 400);
const notFound = () => new BusinessError('DLQ_NOT_FOUND', 'Không tìm thấy thư lỗi', 404);
type DlqRow = Prisma.DeadLetterRecordGetPayload<{ include: { attempts: true } }>;

@Injectable()
export class DlqService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitConnection,
  ) {}

  /** Đọc bản sao trong Report DB, không lấy thư ra khỏi queue RabbitMQ. */
  async list(input: unknown) {
    const parsed = filtersSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    const { page, pageSize, service, eventType, status } = parsed.data;
    const where = {
      sourceService: service,
      eventType,
      attempts: status ? { some: { status } } : undefined,
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.deadLetterRecord.count({ where }),
      this.prisma.deadLetterRecord.findMany({
        where,
        orderBy: [{ failedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { attempts: { orderBy: { requestedAt: 'desc' }, take: 1 } },
      }),
    ]);
    return { page, pageSize, total, items: rows.map((row) => this.present(row)) };
  }

  /** Chi tiết vẫn chỉ chứa metadata đã lọc; raw payload không rời khỏi backend. */
  async detail(id: string) {
    if (!z.uuid().safeParse(id).success) throw invalid();
    const row = await this.prisma.deadLetterRecord.findUnique({
      where: { id },
      include: { attempts: { orderBy: { requestedAt: 'desc' }, take: 10 } },
    });
    if (!row) throw notFound();
    return this.present(row);
  }

  /** Trả metadata công khai và trạng thái audit; content/header gốc không được serialize. */
  private present(row: DlqRow) {
    return {
      id: row.id,
      sourceQueue: row.sourceQueue,
      sourceService: row.sourceService,
      routingKey: row.routingKey,
      deadLetterQueue: `${row.sourceQueue}.dlq`,
      eventType: row.eventType,
      eventId: row.eventId,
      correlationId: row.correlationId,
      failureKind: row.failureKind,
      failureReason: row.failureReason,
      retryCount: row.retryCount,
      failedAt: row.failedAt,
      replayCount: row.replayCount,
      replayable:
        replayEnvelope(row.content, row.sourceQueue) !== null &&
        row.replayCount < MAX_REPLAYS &&
        (row.replayLeaseUntil === null || row.replayLeaseUntil < new Date()),
      attempts: row.attempts.map(
        ({ id, actorId, status, requestedAt, publishedAt, failureCode }) => ({
          id,
          actorId,
          status,
          requestedAt,
          publishedAt,
          failureCode,
        }),
      ),
    };
  }

  /** Claim một lần replay trong DB để hai ADMIN không gửi song song cùng thư. */
  private async claim(id: string, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.deadLetterRecord.findUnique({ where: { id } });
      if (!row) throw notFound();
      const envelope = replayEnvelope(row.content, row.sourceQueue);
      if (!envelope)
        throw new BusinessError('DLQ_NOT_REPLAYABLE', 'Thư này không thể phát lại an toàn', 409);
      const now = new Date();
      const claimed = await tx.deadLetterRecord.updateMany({
        where: {
          id,
          replayCount: { lt: MAX_REPLAYS },
          OR: [{ replayLeaseUntil: null }, { replayLeaseUntil: { lt: now } }],
        },
        data: { replayCount: { increment: 1 }, replayLeaseUntil: new Date(now.getTime() + 60_000) },
      });
      if (claimed.count !== 1)
        throw new BusinessError('DLQ_REPLAY_BUSY', 'Thư đang được phát lại hoặc đã hết lượt', 409);
      const attemptId = randomUUID();
      await tx.dlqReplayAttempt.create({ data: { id: attemptId, recordId: id, actorId } });
      return { row, envelope, attemptId };
    });
  }

  /** Phát bản sao có confirm; thư DLQ gốc luôn còn nguyên và consumer chống trùng bằng eventId. */
  async replay(id: string, actorId: string) {
    if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(actorId).success) throw invalid();
    const { row, envelope, attemptId } = await this.claim(id, actorId);
    try {
      await this.rabbit.publish({
        exchange: EVENTS_EXCHANGE,
        routingKey: envelope.eventType,
        content: Buffer.from(row.content),
        messageId: attemptId,
        headers: {
          [MESSAGE_HEADERS.CORRELATION_ID]: envelope.correlationId,
          [MESSAGE_HEADERS.ORIGINAL_ROUTING_KEY]: envelope.eventType,
          [MESSAGE_HEADERS.REPLAY_ATTEMPT_ID]: attemptId,
        },
      });
    } catch (error) {
      const definiteFailure = error instanceof UnroutableMessageError;
      try {
        await this.finish(attemptId, definiteFailure ? 'PUBLISH_FAILED' : 'PUBLISH_UNCONFIRMED');
      } catch {
        throw new BusinessError(
          'DLQ_AUDIT_UNCONFIRMED',
          'Không ghi được audit; kiểm tra trạng thái broker trước khi thử lại.',
          503,
        );
      }
      if (definiteFailure) {
        throw new BusinessError(
          'DLQ_PUBLISH_FAILED',
          'Không có queue nhận sự kiện; thư DLQ gốc còn nguyên.',
          503,
        );
      }
      throw new BusinessError(
        'DLQ_PUBLISH_UNCONFIRMED',
        'Chưa xác nhận được broker đã nhận thư. Kiểm tra nhật ký trước khi thử lại.',
        503,
      );
    }
    try {
      await this.finish(attemptId, 'REPUBLISHED');
    } catch {
      throw new BusinessError(
        'DLQ_AUDIT_UNCONFIRMED',
        'Broker đã nhận bản sao, nhưng chưa ghi được kết quả vào audit.',
        503,
      );
    }
    return {
      attemptId,
      status: 'REPUBLISHED',
      message: 'Broker đã nhận bản sao; chưa xác nhận xử lý nghiệp vụ.',
    };
  }

  /** Ghi kết quả publisher; không ghi PROCESSING_SUCCEEDED khi chỉ có confirm. */
  private async finish(
    attemptId: string,
    status: 'REPUBLISHED' | 'PUBLISH_FAILED' | 'PUBLISH_UNCONFIRMED',
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.dlqReplayAttempt.updateMany({
        where: { id: attemptId, status: 'REQUESTED' },
        data: {
          status,
          publishedAt: status === 'REPUBLISHED' ? new Date() : null,
          failureCode: status === 'REPUBLISHED' ? null : status,
        },
      });
      const attempt = await tx.dlqReplayAttempt.findUnique({
        where: { id: attemptId },
        select: { recordId: true },
      });
      if (attempt)
        await tx.deadLetterRecord.update({
          where: { id: attempt.recordId },
          data: { replayLeaseUntil: null },
        });
    });
  }
}
