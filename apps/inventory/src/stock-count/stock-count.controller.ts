import { type AuthUser, CurrentUser, ZodValidationPipe } from '@jewelry/common';
import {
  type CreateStockCountRequest,
  createStockCountRequestSchema,
  type ScanResult,
  type ScanStockCountRequest,
  scanStockCountRequestSchema,
  type StockCountSummary,
} from '@jewelry/contracts';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { UUID_PARAM } from '../common/uuid-param';
import { StockCountService } from './stock-count.service';

/** Cửa vào HTTP của kiểm kê. Quyền theo chi nhánh kiểm trong service, vì `/stock-counts/{id}` không nêu chi nhánh. */
@Controller('admin/stock-counts')
export class StockCountController {
  constructor(private readonly stockCounts: StockCountService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createStockCountRequestSchema)) body: CreateStockCountRequest,
  ): Promise<StockCountSummary> {
    return this.stockCounts.createStockCount(user, body);
  }

  @Post(':stockCountId/scan')
  @HttpCode(200)
  scan(
    @CurrentUser() user: AuthUser,
    @Param('stockCountId', UUID_PARAM) stockCountId: string,
    @Body(new ZodValidationPipe(scanStockCountRequestSchema)) body: ScanStockCountRequest,
  ): Promise<ScanResult> {
    return this.stockCounts.scanTag(user, stockCountId, body);
  }

  @Post(':stockCountId/close')
  @HttpCode(200)
  close(
    @CurrentUser() user: AuthUser,
    @Param('stockCountId', UUID_PARAM) stockCountId: string,
  ): Promise<StockCountSummary> {
    return this.stockCounts.closeStockCount(user, stockCountId);
  }

  @Get(':stockCountId')
  get(
    @CurrentUser() user: AuthUser,
    @Param('stockCountId', UUID_PARAM) stockCountId: string,
  ): Promise<StockCountSummary> {
    return this.stockCounts.getStockCount(user, stockCountId);
  }
}
