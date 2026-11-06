import { type DynamicModule, Module } from '@nestjs/common';
import { HealthController, READINESS_CHECKS } from './health.controller';
import type { ReadinessCheck } from './readiness';

export interface HealthOptions {
  /** Provider cần cho `readinessChecks`, ví dụ `[PrismaService]`. */
  inject?: (new (...args: never[]) => unknown)[];
  /** Danh sách kiểm tra cho `/health/ready`; bỏ trống thì chỉ cần tiến trình còn sống. */
  readinessChecks?: (...deps: never[]) => ReadinessCheck[];
}

/** `/health/live` (tiến trình còn sống) và `/health/ready` (đủ điều kiện nhận việc, lỗi → 503). */
@Module({})
export class HealthModule {
  static forRoot({ inject = [], readinessChecks = () => [] }: HealthOptions = {}): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: READINESS_CHECKS, inject, useFactory: readinessChecks }],
    };
  }
}
