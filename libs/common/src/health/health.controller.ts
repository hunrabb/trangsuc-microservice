import { Controller, Get, Inject, Logger, Res } from '@nestjs/common';
import { type ReadinessCheck, runReadinessChecks } from './readiness';

export const READINESS_CHECKS = Symbol('READINESS_CHECKS');

interface ReadyResponse {
  status: 'ok' | 'error';
  checks: Record<string, string>;
}

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[]) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Chi tiết lỗi chỉ ghi log, phản hồi chỉ nói kiểm tra nào hỏng.
   * Đặt status trực tiếp thay vì ném lỗi: body của /health/* không theo định dạng lỗi chung.
   */
  @Get('ready')
  async ready(
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ): Promise<ReadyResponse> {
    const report = await runReadinessChecks(this.checks, (name, error) => {
      this.logger.warn(`Kiểm tra sẵn sàng "${name}" thất bại: ${String(error)}`);
    });
    if (!report.ready) {
      response.status(503);
    }
    return { status: report.ready ? 'ok' : 'error', checks: report.checks };
  }
}
