import { Public } from '@jewelry/common';
import { Controller, Get } from '@nestjs/common';
import { SERVICE_NAME } from '../config/env';

/** Chỉ gọi được từ mạng nội bộ Docker. Gateway không bao giờ chuyển tiếp /internal/*. */
@Public()
@Controller('internal')
export class InternalPingController {
  @Get('ping')
  ping(): { service: string; ok: true } {
    return { service: SERVICE_NAME, ok: true };
  }
}
