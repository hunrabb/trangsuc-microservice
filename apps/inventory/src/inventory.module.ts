import { InternalBuybackPriceController } from './catalog/internal-buyback-price.controller';
import { InternalExchangeController } from './stock/internal-exchange.controller';
import { ExchangeHoldsService } from './stock/exchange-holds.service';
import { ExchangeExpiryWorker } from './stock/exchange-expiry.worker';
import { ReservationExpiryWorker } from './online/reservation-expiry.worker';
import { OnlineConfigController } from './catalog/online-config.controller';
import { CatalogPublisher } from './catalog/catalog-publisher';
import { Module } from '@nestjs/common';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { MetalsController } from './catalog/metals.controller';
import { MetalsService } from './catalog/metals.service';
import { ReceiptsController } from './receipts/receipts.controller';
import { ReceiptsService } from './receipts/receipts.service';
import { LabelController } from './stock/label.controller';
import { InternalStockController } from './stock/internal-stock.controller';
import { ItemSalesService } from './stock/item-sales.service';
import { StockController } from './stock/stock.controller';
import { StockService } from './stock/stock.service';
import { InventoryCloseWorker } from './stock/inventory-close.worker';

/** Các luồng nghiệp vụ của inventory (3A): kim loại và giá, danh mục, phiếu nhập, tồn kho. */
@Module({
  controllers: [
    InternalBuybackPriceController,
    InternalExchangeController,
    OnlineConfigController,
    MetalsController,
    CatalogController,
    ReceiptsController,
    StockController,
    InternalStockController,
    LabelController,
  ],
  providers: [
    ReservationExpiryWorker,
    ExchangeHoldsService,
    ExchangeExpiryWorker,
    CatalogPublisher,
    MetalsService,
    CatalogService,
    ReceiptsService,
    StockService,
    ItemSalesService,
    InventoryCloseWorker,
  ],
})
export class InventoryModule {}
