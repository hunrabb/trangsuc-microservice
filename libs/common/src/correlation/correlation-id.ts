import { randomUUID } from 'node:crypto';
import { CLS_ID, ClsServiceManager } from 'nestjs-cls';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nhận mã từ header nếu là UUID hợp lệ, không thì sinh mới. Header lặp lại không phải một UUID nên cũng bị bỏ. */
export function resolveCorrelationId(header: string | string[] | undefined): string {
  return typeof header === 'string' && UUID_PATTERN.test(header) ? header : randomUUID();
}

/** correlationId của request hiện tại; `undefined` nếu đang ở ngoài một request. */
export function getCorrelationId(): string | undefined {
  const cls = ClsServiceManager.getClsService();
  return cls.isActive() ? cls.getId() : undefined;
}

/** Chạy một việc ngoài request (worker, consumer) trong ngữ cảnh có correlationId, để log có mã đó. */
export function runWithCorrelationId<T>(correlationId: string, work: () => Promise<T>): Promise<T> {
  const cls = ClsServiceManager.getClsService();
  return cls.run(() => {
    cls.set(CLS_ID, correlationId);
    return work();
  });
}

/** Header cần gửi kèm khi gọi HTTP sang service khác. */
export function correlationHeaders(): Record<string, string> {
  const id = getCorrelationId();
  return id === undefined ? {} : { [CORRELATION_ID_HEADER]: id };
}
