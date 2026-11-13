import { BusinessError, callInternal, ConfigService } from '@jewelry/common';
import { inventoryBuybackPriceSchema } from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import type { Env } from '../config/env';

@Injectable()
export class BuybackPriceClient {
  constructor(private readonly config: ConfigService<Env, true>) {}
  async current(metalId: string) {
    const base = this.config.get('INVENTORY_URL', { infer: true }).replace(/\/$/, '');
    const parsed = inventoryBuybackPriceSchema.safeParse(
      await callInternal({
        url: `${base}/internal/buyback-prices/${metalId}`,
        timeoutMs: 3000,
      }),
    );
    if (!parsed.success || parsed.data.metalId !== metalId)
      throw new BusinessError('SERVICE_UNAVAILABLE', 'Nguồn giá mua vào không hợp lệ', 503);
    return parsed.data;
  }
}
