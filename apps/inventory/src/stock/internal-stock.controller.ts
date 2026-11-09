import { Public, ZodValidationPipe } from '@jewelry/common';
import {
  type DeductStockRequest,
  deductStockRequestSchema,
  type DeductStockResponse,
  type QuoteStockRequest,
  quoteStockRequestSchema,
  type QuoteStockResponse,
  type ReleaseStockRequest,
  releaseStockRequestSchema,
  type ReleaseStockResponse,
  type StockOrderStateResponse,
} from '@jewelry/contracts';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ItemSalesService } from './item-sales.service';

/**
 * API nội bộ cho sales (POS). Chỉ gọi được từ mạng nội bộ Docker: gateway không bao giờ chuyển tiếp `/internal/*`,
 * nên không có người dùng và không kiểm token. Controller chỉ nhận việc, kiểm tra dữ liệu và gọi service.
 */
@Public()
@Controller('internal/stock')
export class InternalStockController {
  constructor(private readonly itemSales: ItemSalesService) {}

  @Post('quote')
  @HttpCode(200)
  quote(
    @Body(new ZodValidationPipe(quoteStockRequestSchema)) body: QuoteStockRequest,
  ): Promise<QuoteStockResponse> {
    return this.itemSales.quoteItems(body);
  }

  @Post('deduct')
  @HttpCode(200)
  deduct(
    @Body(new ZodValidationPipe(deductStockRequestSchema)) body: DeductStockRequest,
  ): Promise<DeductStockResponse> {
    return this.itemSales.deductItemsForOrder(body);
  }

  @Post('release')
  @HttpCode(200)
  release(
    @Body(new ZodValidationPipe(releaseStockRequestSchema)) body: ReleaseStockRequest,
  ): Promise<ReleaseStockResponse> {
    return this.itemSales.releaseItemsForOrder(body.orderId);
  }

  /** Sales đọc dấu release và những chiếc đã bán cho đơn trước khi phục hồi sau crash. */
  @Get('orders/:orderId')
  state(@Param('orderId', new ParseUUIDPipe()) orderId: string): Promise<StockOrderStateResponse> {
    return this.itemSales.getOrderState(orderId);
  }
}
