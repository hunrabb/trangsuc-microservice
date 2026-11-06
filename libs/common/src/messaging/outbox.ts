import { randomUUID } from 'node:crypto';
import {
  EVENT_PAYLOAD_SCHEMAS,
  type EventPayload,
  type EventType,
  isEventType,
} from '@jewelry/contracts';
import { getCorrelationId } from '../correlation/correlation-id';

export const OUTBOX_MAX_ATTEMPTS = 10;

/** Phần tối thiểu của `tx` trong `prisma.$transaction`. `libs/` không import Prisma client của app nào. */
export interface OutboxTx {
  outboxEvent: {
    create(args: {
      data: {
        id: string;
        eventType: string;
        aggregateType: string;
        aggregateId: string;
        payload: never;
        correlationId: string;
      };
    }): Promise<unknown>;
  };
}

export interface OutboxInput<T extends EventType> {
  eventType: T;
  aggregateType: string;
  aggregateId: string;
  payload: EventPayload<T>;
}

export const outbox = {
  /**
   * Ghi sự kiện `PENDING` trong transaction của người gọi: rollback thì không có thư nào được gửi.
   * Payload sai schema là lỗi lập trình: ném lỗi để cả transaction bị huỷ. Trả về `eventId`.
   */
  async add<T extends EventType>(tx: OutboxTx, input: OutboxInput<T>): Promise<string> {
    if (!isEventType(input.eventType)) {
      throw new Error(`Sự kiện chưa khai báo trong contracts: ${String(input.eventType)}`);
    }
    const payload = EVENT_PAYLOAD_SCHEMAS[input.eventType].parse(input.payload);
    const id = randomUUID();
    await tx.outboxEvent.create({
      data: {
        id,
        eventType: input.eventType,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        payload: payload as never,
        correlationId: getCorrelationId() ?? randomUUID(),
      },
    });
    return id;
  },
};
