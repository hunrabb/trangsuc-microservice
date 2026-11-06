import type { INestApplication, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

export interface BootstrapOptions {
  service: string;
  module: Type<unknown>;
  /** Việc riêng của app, chạy trước khi nhận request (ví dụ middleware chặn đường nội bộ). */
  configure?: (app: INestApplication) => void;
}

async function start({ module, configure }: BootstrapOptions): Promise<void> {
  const app = await NestFactory.create(module, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  configure?.(app);

  const port = app.get(ConfigService).getOrThrow<number>('PORT');
  await app.listen(port, '0.0.0.0');
}

/** Khởi động một app NestJS; lỗi khởi động ghi log JSON rồi thoát mã 1. */
export async function bootstrapService(options: BootstrapOptions): Promise<void> {
  try {
    await start(options);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'fatal',
        service: options.service,
        msg: 'Không khởi động được dịch vụ',
        err:
          error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      }),
    );
    process.exit(1);
  }
}
