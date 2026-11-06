import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { z } from 'zod';
import { validateEnv } from './parse-env';

export interface AppConfigOptions {
  service: string;
  schema: z.ZodType;
}

/**
 * Kiểm tra biến môi trường lúc khởi động theo schema của app rồi cung cấp `ConfigService` toàn cục.
 * Dùng có kiểu: `constructor(config: ConfigService<Env, true>)`, đọc bằng `config.get('PORT', { infer: true })`.
 */
@Module({})
export class AppConfigModule {
  static forRoot({ service, schema }: AppConfigOptions): DynamicModule {
    return {
      module: AppConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env',
          validate: (raw) => validateEnv(schema, raw, service) as Record<string, unknown>,
        }),
      ],
    };
  }
}
