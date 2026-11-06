import { callInternal, ConfigService, Public } from '@jewelry/common';
import { Controller, Get } from '@nestjs/common';
import type { Env } from '../config/env';

@Public()
@Controller('api')
export class PingController {
  constructor(private readonly config: ConfigService<Env, true>) {}

  /**
   * Kiểm tra đường đi React → gateway → inventory trong mạng nội bộ.
   * Trả nguyên kết quả của inventory: {"service":"inventory","ok":true}.
   */
  @Get('ping')
  ping(): Promise<unknown> {
    return callInternal({
      url: new URL('/internal/ping', this.config.get('INVENTORY_URL', { infer: true })),
    });
  }
}
