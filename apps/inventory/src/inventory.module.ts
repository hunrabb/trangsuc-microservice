import { Module } from '@nestjs/common';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { MetalsController } from './catalog/metals.controller';
import { MetalsService } from './catalog/metals.service';
import { ReceiptsController } from './receipts/receipts.controller';
import { ReceiptsService } from './receipts/receipts.service';
import { StockCountController } from './stock-count/stock-count.controller';
import { StockCountService } from './stock-count/stock-count.service';
import { LabelController } from './stock/label.controller';
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
    StockCountController,
    LabelController,
  ],
  providers: [
    MetalsService,
    CatalogService,
    ReceiptsService,
    StockService,
    ItemSalesService,
    StockCountService,
  ],
})
export class InventoryModule {}
