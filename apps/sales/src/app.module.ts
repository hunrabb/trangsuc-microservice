import { MyOrdersController } from './online/my-orders.controller';
import { BuybacksModule } from './buybacks/buybacks.module';
import { OnlinePaymentsController } from './payments/online-payments.controller';
import { OnlinePaymentsService } from './payments/online-payments.service';
import { onPaymentInventoryResult } from './payments/payment-inventory-events';
import { ROUTING_KEYS } from '@jewelry/contracts';
import { OnlineOrdersController } from './online/online-orders.controller';
import { OnlineOrdersService } from './online/online-orders.service';
import { OnlineRecoveryWorker } from './online/online-recovery.worker';
import { ONLINE_SALES_HANDLERS } from './online/online-order-events';
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
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { QUEUES } from '@jewelry/contracts';
import { CATALOG_HANDLERS } from './catalog/catalog-events';
import { PublicCatalogController } from './catalog/catalog.controller';
import { PublicCatalogService } from './catalog/catalog.service';
import { PosModule } from './pos/pos.module';

@Module({
  controllers: [
    MyOrdersController,
    PublicCatalogController,
    OnlineOrdersController,
    OnlinePaymentsController,
  ],
  providers: [
    PublicCatalogService,
    OnlineOrdersService,
    OnlineRecoveryWorker,
    OnlinePaymentsService,
  ],
  imports: [
    AppConfigModule.forRoot({ service: SERVICE_NAME, schema: envSchema }),
    CorrelationModule,
    AppLoggerModule.forRoot(SERVICE_NAME),
    JwtAuthModule,
    PrismaModule,
    PosModule,
    BuybacksModule,
    MessagingModule.forRoot({
      service: SERVICE_NAME,
      dbSchema: DB_SCHEMA,
      inject: [PrismaService],
      database: (prisma: PrismaService) => prisma,
      consumer: {
        queue: QUEUES.SALES,
        handlers: {
          ...CATALOG_HANDLERS,
          ...ONLINE_SALES_HANDLERS,
          [ROUTING_KEYS.STOCK_PAYMENT_RESULT]: onPaymentInventoryResult,
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
