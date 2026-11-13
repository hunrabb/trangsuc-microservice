import { BusinessError, callInternal, ConfigService } from '@jewelry/common';
import { exchangeHoldSchema, type ExchangeHold } from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import type { Env } from '../config/env';

@Injectable()
export class ExchangeClient {
  constructor(private readonly config: ConfigService<Env, true>) {}
  private url(path: string) {
    return `${this.config.get('INVENTORY_URL', { infer: true }).replace(/\/$/, '')}/internal/exchanges${path}`;
  }
  private parse(value: unknown, id: string): ExchangeHold {
    const parsed = exchangeHoldSchema.safeParse(value);
    if (!parsed.success || parsed.data.exchangeId !== id)
      throw new BusinessError('SERVICE_UNAVAILABLE', 'Phản hồi giữ hàng không hợp lệ', 503);
    return parsed.data;
  }
  async reserve(id: string, branchId: string, tagCode: string) {
    return this.parse(
      await callInternal({
        url: this.url('/reserve'),
        method: 'POST',
        body: { exchangeId: id, branchId, tagCode },
        idempotent: true,
        timeoutMs: 3000,
      }),
      id,
    );
  }
  async state(id: string) {
    const value = await callInternal({ url: this.url(`/${id}`), timeoutMs: 3000 });
    return value === null ? null : this.parse(value, id);
  }
  async protect(id: string) {
    return this.parse(
      await callInternal({
        url: this.url(`/${id}/protect`),
        method: 'POST',
        body: {},
        idempotent: true,
        timeoutMs: 3000,
      }),
      id,
    );
  }
  async consume(id: string) {
    return this.parse(
      await callInternal({
        url: this.url(`/${id}/consume`),
        method: 'POST',
        body: {},
        idempotent: true,
        timeoutMs: 3000,
      }),
      id,
    );
  }
  async release(id: string) {
    await callInternal({
      url: this.url('/release'),
      method: 'POST',
      body: { exchangeId: id },
      idempotent: true,
      timeoutMs: 3000,
    });
  }
}
