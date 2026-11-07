import { BusinessError } from '@jewelry/common';
import { Injectable } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { rateLimitsFor } from './rate-limit-rules';

/**
 * Dùng bộ đếm của `@nestjs/throttler` trực tiếp thay vì guard: guard chạy trước khi gateway đọc body, nên
 * không biết email để đếm theo IP + email. Bộ đếm nằm trong bộ nhớ, chỉ đúng khi chạy một instance gateway.
 */
@Injectable()
export class RateLimitService {
  constructor(private readonly storage: ThrottlerStorageService) {}

  async enforce(
    method: string,
    servicePath: string,
    clientIp: string,
    body: Buffer | undefined,
    userId: string | undefined,
    response: { setHeader(name: string, value: string): unknown },
  ): Promise<void> {
    let retryAfter = 0;
    // Tăng mọi bộ đếm, kể cả khi bộ đầu đã vượt: lần bị chặn vẫn phải tính vào giới hạn theo IP.
    for (const { key, limit, ttlMs } of rateLimitsFor(
      method,
      servicePath,
      clientIp,
      body,
      userId,
    )) {
      const record = await this.storage.increment(key, ttlMs, limit, ttlMs, key);
      if (record.isBlocked) {
        retryAfter = Math.max(retryAfter, record.timeToBlockExpire, 1);
      }
    }
    if (retryAfter > 0) {
      response.setHeader('retry-after', String(retryAfter));
      throw new BusinessError('RATE_LIMITED', 'Quá nhiều lần thử, vui lòng thử lại sau', 429);
    }
  }
}
