import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { SERVICE_NAME, validateEnv } from './config/env';
import { HealthController } from './health/health.controller';
import { PingController } from './ping/ping.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env', validate: validateEnv }),
    LoggerModule.forRoot({
      pinoHttp: {
        base: { service: SERVICE_NAME },
        formatters: { level: (label) => ({ level: label }) },
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
      },
    }),
  ],
  controllers: [HealthController, PingController],
})
export class AppModule {}
