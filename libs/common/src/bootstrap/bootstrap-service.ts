import type { Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { GlobalExceptionFilter } from '../errors/global-exception.filter';

export interface BootstrapOptions {
  service: string;
  module: Type<unknown>;
  /** `false`: app tự đọc body thô (gateway chuyển tiếp nguyên byte). */
  bodyParser?: boolean;
}

async function start({ module, bodyParser = true }: BootstrapOptions): Promise<void> {
  const app = await NestFactory.create(module, { bufferLogs: true, bodyParser });
  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks();

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
