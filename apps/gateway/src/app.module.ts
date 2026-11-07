import {
  AppConfigModule,
  AppLoggerModule,
  CorrelationModule,
  HealthModule,
  JwtAuthModule,
} from '@jewelry/common';
import { Module } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { envSchema, SERVICE_NAME } from './config/env';
import { PingController } from './ping/ping.controller';
import { ProxyController } from './proxy/proxy.controller';
import { RateLimitService } from './proxy/rate-limit.service';

@Module({
  imports: [
    AppConfigModule.forRoot({ service: SERVICE_NAME, schema: envSchema }),
    CorrelationModule,
    AppLoggerModule.forRoot(SERVICE_NAME),
    JwtAuthModule,
    HealthModule.forRoot(),
  ],
  // Thứ tự có ý nghĩa: ProxyController bắt mọi /api/*, phải đứng sau.
  controllers: [PingController, ProxyController],
  providers: [ThrottlerStorageService, RateLimitService],
})
export class AppModule {}
