import { ConfigService, correlationHeaders } from '@jewelry/common';
import {
  BadGatewayException,
  Controller,
  GatewayTimeoutException,
  Get,
  Logger,
} from '@nestjs/common';
import type { Env } from '../config/env';

/** Thời gian chờ tối đa khi gọi service phía sau (CLAUDE.md mục 8: gọi trực tiếp timeout 3 s). */
export const UPSTREAM_TIMEOUT_MS = 3000;

@Controller('api')
export class PingController {
  private readonly logger = new Logger(PingController.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  /**
   * Kiểm tra đường đi React → gateway → inventory trong mạng nội bộ.
   * Trả nguyên kết quả của inventory: {"service":"inventory","ok":true}.
   */
  @Get('ping')
  async ping(): Promise<unknown> {
    const url = new URL('/internal/ping', this.config.get('INVENTORY_URL', { infer: true }));
    try {
      const response = await fetch(url, {
        headers: correlationHeaders(),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.error(`inventory trả về HTTP ${response.status} cho ${url.pathname}`);
        throw new BadGatewayException({
          code: 'UPSTREAM_ERROR',
          message: 'Dịch vụ inventory trả về lỗi',
        });
      }
      return await response.json();
    } catch (error) {
      if (error instanceof BadGatewayException) {
        throw error;
      }
      if (error instanceof Error && error.name === 'TimeoutError') {
        this.logger.error(`inventory không trả lời trong ${UPSTREAM_TIMEOUT_MS} ms`);
        throw new GatewayTimeoutException({
          code: 'UPSTREAM_TIMEOUT',
          message: 'Dịch vụ inventory không trả lời kịp',
        });
      }
      this.logger.error(`không gọi được inventory: ${String(error)}`);
      throw new BadGatewayException({
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Không kết nối được dịch vụ inventory',
      });
    }
  }
}
