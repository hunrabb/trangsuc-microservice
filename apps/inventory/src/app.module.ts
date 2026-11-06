import {
  AppConfigModule,
  AppLoggerModule,
  CorrelationModule,
  HealthModule,
  postgresCheck,
} from '@jewelry/common';
import { Module } from '@nestjs/common';
import { envSchema, SERVICE_NAME } from './config/env';
import { InternalPingController } from './internal/ping.controller';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';

@Module({
  imports: [
    AppConfigModule.forRoot({ service: SERVICE_NAME, schema: envSchema }),
    CorrelationModule,
    AppLoggerModule.forRoot(SERVICE_NAME),
    PrismaModule,
    HealthModule.forRoot({
      inject: [PrismaService],
      readinessChecks: (prisma: PrismaService) => [postgresCheck(prisma)],
    }),
  ],
  controllers: [InternalPingController],
})
export class AppModule {}
