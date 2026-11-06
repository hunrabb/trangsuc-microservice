import { AppConfigModule, AppLoggerModule, CorrelationModule, HealthModule } from '@jewelry/common';
import { Module } from '@nestjs/common';
import { envSchema, SERVICE_NAME } from './config/env';
import { PingController } from './ping/ping.controller';
import { ProxyController } from './proxy/proxy.controller';

@Module({
  imports: [
    AppConfigModule.forRoot({ service: SERVICE_NAME, schema: envSchema }),
    CorrelationModule,
    AppLoggerModule.forRoot(SERVICE_NAME),
    HealthModule.forRoot(),
  ],
  // Thứ tự có ý nghĩa: ProxyController bắt mọi /api/*, phải đứng sau.
  controllers: [PingController, ProxyController],
})
export class AppModule {}
