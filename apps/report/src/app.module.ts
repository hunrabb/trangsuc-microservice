import {
  AppConfigModule,
  AppLoggerModule,
  CorrelationModule,
  HealthModule,
  JwtAuthModule,
  MessagingModule,
  postgresCheck,
  rabbitCheck,
  RabbitConnection,
} from '@jewelry/common';
import { QUEUES, ROUTING_KEYS } from '@jewelry/contracts';
import { Module } from '@nestjs/common';
import { DB_SCHEMA, envSchema, SERVICE_NAME } from './config/env';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { handleSystemTest } from './system/system-test.handler';

@Module({
  imports: [
    AppConfigModule.forRoot({ service: SERVICE_NAME, schema: envSchema }),
    CorrelationModule,
    AppLoggerModule.forRoot(SERVICE_NAME),
    JwtAuthModule,
    PrismaModule,
    MessagingModule.forRoot({
      service: SERVICE_NAME,
      dbSchema: DB_SCHEMA,
      inject: [PrismaService],
      database: (prisma: PrismaService) => prisma,
      consumer: {
        queue: QUEUES.REPORT,
        handlers: { [ROUTING_KEYS.SYSTEM_TEST]: handleSystemTest as never },
      },
    }),
    HealthModule.forRoot({
      inject: [PrismaService, RabbitConnection],
      readinessChecks: (prisma: PrismaService, rabbit: RabbitConnection) => [
        postgresCheck(prisma),
        rabbitCheck(rabbit),
      ],
    }),
  ],
})
export class AppModule {}
