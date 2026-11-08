import { Module } from '@nestjs/common';
import { OrderStore } from '../core/order-store';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryStockClient } from './inventory-stock.client';
import { PosOrdersController } from './pos-orders.controller';
import { PosOrdersService } from './pos-orders.service';

@Module({
  imports: [PrismaModule],
  controllers: [PosOrdersController],
  providers: [OrderStore, InventoryStockClient, PosOrdersService],
})
export class PosModule {}
