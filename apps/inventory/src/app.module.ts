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
import { Module } from '@nestjs/common';
import { DB_SCHEMA, envSchema, SERVICE_NAME } from './config/env';
import { InternalPingController } from './internal/ping.controller';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';

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
    }),
    HealthModule.forRoot({
      inject: [PrismaService, RabbitConnection],
      readinessChecks: (prisma: PrismaService, rabbit: RabbitConnection) => [
        postgresCheck(prisma),
        rabbitCheck(rabbit),
      ],
    }),
  ],
  controllers: [InternalPingController],
})
export class AppModule {}
