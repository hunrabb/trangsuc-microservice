import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { type ReadinessCheck, runReadinessChecks } from './readiness';

export const READINESS_CHECKS = Symbol('READINESS_CHECKS');

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[]) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Chi tiết lỗi chỉ ghi log, phản hồi chỉ nói kiểm tra nào hỏng. */
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: Record<string, string> }> {
    const report = await runReadinessChecks(this.checks, (name, error) => {
      this.logger.warn(`Kiểm tra sẵn sàng "${name}" thất bại: ${String(error)}`);
    });
    if (!report.ready) {
      throw new ServiceUnavailableException({ status: 'error', checks: report.checks });
    }
    return { status: 'ok', checks: report.checks };
  }
}
