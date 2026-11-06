import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { SERVICE_NAME, type Env } from './config/env';
import { INTERNAL_PREFIX, blockInternal } from './security/block-internal';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  // Đăng ký trước mọi định tuyến khác: /internal/* không bao giờ ra khỏi gateway.
  app.use(INTERNAL_PREFIX, blockInternal);

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  await app.listen(config.get('PORT', { infer: true }), '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: 'fatal',
      service: SERVICE_NAME,
      msg: 'Không khởi động được dịch vụ',
      err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
    }),
  );
  process.exit(1);
});
