import { Module } from '@nestjs/common';
import { OrderStore } from '../core/order-store';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryStockClient } from './inventory-stock.client';
import { PosCustomersController } from './pos-customers.controller';
import { PosCustomersService } from './pos-customers.service';
import { PosOrdersController } from './pos-orders.controller';
import { PosOrdersService } from './pos-orders.service';
import { PosRecoveryWorker } from './pos-recovery.worker';

@Module({
  imports: [PrismaModule],
  controllers: [PosOrdersController, PosCustomersController],
  providers: [
    OrderStore,
    InventoryStockClient,
    PosOrdersService,
    PosCustomersService,
    PosRecoveryWorker,
  ],
})
export class PosModule {}
