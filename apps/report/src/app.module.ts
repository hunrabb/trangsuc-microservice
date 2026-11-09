import { dispatchPaidOrder } from './orders/paid-order-dispatch';
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
import { acknowledgeStockChanged } from './stock/stock-changed.handler';
import { recordInventorySnapshot } from './stock/inventory-snapshot.handler';
import { recordCancelledOrder } from './orders/order-report.handler';
import { ReportsController } from './orders/reports.controller';
import { ReportsService } from './orders/reports.service';
import { StockReportsService } from './stock/stock-reports.service';
import { ReportExportService } from './orders/report-export.service';
import { DlqController } from './dlq/dlq.controller';
import { DlqService } from './dlq/dlq.service';
import { DlqObserver } from './dlq/dlq-observer';

@Module({
  controllers: [ReportsController, DlqController],
  providers: [ReportsService, StockReportsService, ReportExportService, DlqService, DlqObserver],
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
        handlers: {
          [ROUTING_KEYS.SYSTEM_TEST]: handleSystemTest as never,
          [ROUTING_KEYS.STOCK_CHANGED]: acknowledgeStockChanged as never,
          [ROUTING_KEYS.INVENTORY_SNAPSHOT_CLOSED]: recordInventorySnapshot as never,
          [ROUTING_KEYS.ORDER_PAID]: dispatchPaidOrder as never,
          [ROUTING_KEYS.ORDER_CANCELLED]: recordCancelledOrder as never,
        },
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
