import { setTimeout as sleep } from 'node:timers/promises';
import { BusinessError } from '../errors/business-error';
import { isDeadlock, isLockTimeout } from '../messaging/message-errors';

const MAX_ATTEMPTS = 3;

const randomDelayMs = () => 20 + Math.random() * 40;

const busy = () =>
  new BusinessError('SERVICE_UNAVAILABLE', 'Hệ thống đang bận, vui lòng thử lại', 503);

/**
 * Chạy một transaction có khoá dòng (CLAUDE.md mục 7). `work` phải tạo transaction MỚI mỗi lần gọi.
 * - Deadlock: Postgres huỷ một bên nên chạy lại cả transaction, tối đa 3 lần, nghỉ 20–60 ms.
 * - Vẫn deadlock, hoặc hết `lock_timeout`: `503` để client thử lại, không phải lỗi hệ thống.
 */
export async function runWithLockRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (isLockTimeout(error) || (isDeadlock(error) && attempt === MAX_ATTEMPTS)) {
        throw busy();
      }
      if (!isDeadlock(error)) {
        throw error;
      }
      await sleep(randomDelayMs());
    }
  }
}
