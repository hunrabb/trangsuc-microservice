import { Module } from '@nestjs/common';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { MetalsController } from './catalog/metals.controller';
import { MetalsService } from './catalog/metals.service';
import { ReceiptsController } from './receipts/receipts.controller';
import { ReceiptsService } from './receipts/receipts.service';
import { InternalStockController } from './stock/internal-stock.controller';
import { ItemSalesService } from './stock/item-sales.service';
import { StockController } from './stock/stock.controller';
import { StockService } from './stock/stock.service';

/** Các luồng nghiệp vụ của inventory (3A): kim loại và giá, danh mục, phiếu nhập, tồn kho. */
@Module({
  controllers: [
    MetalsController,
    CatalogController,
    ReceiptsController,
    StockController,
    InternalStockController,
  ],
  providers: [MetalsService, CatalogService, ReceiptsService, StockService, ItemSalesService],
})
export class InventoryModule {}
