import { type AuthUser, CurrentUser, ZodValidationPipe } from '@jewelry/common';
import {
  type AddReceiptLineRequest,
  addReceiptLineRequestSchema,
  type ApproveReceiptRequest,
  approveReceiptRequestSchema,
  type CreateReceiptRequest,
  createReceiptRequestSchema,
  type ListReceiptsQuery,
  listReceiptsQuerySchema,
  type Receipt,
  type ReceiptPage,
} from '@jewelry/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { UUID_PARAM } from '../common/uuid-param';
import { ReceiptsService } from './receipts.service';

/**
 * Cửa vào HTTP của phiếu nhập. Không dùng `@Roles`: `/receipts/{id}` không nêu chi nhánh, chi nhánh chỉ biết sau
 * khi đọc phiếu, nên quyền theo chi nhánh kiểm trong service (`common/branch-access.ts`).
 */
@Controller('admin/receipts')
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createReceiptRequestSchema)) body: CreateReceiptRequest,
  ): Promise<Receipt> {
    return this.receipts.create(user, body);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listReceiptsQuerySchema)) query: ListReceiptsQuery,
  ): Promise<ReceiptPage> {
    return this.receipts.list(user, query);
  }

  @Get(':receiptId')
  get(
    @CurrentUser() user: AuthUser,
    @Param('receiptId', UUID_PARAM) receiptId: string,
  ): Promise<Receipt> {
    return this.receipts.get(user, receiptId);
  }

  @Post(':receiptId/lines')
  addLine(
    @CurrentUser() user: AuthUser,
    @Param('receiptId', UUID_PARAM) receiptId: string,
    @Body(new ZodValidationPipe(addReceiptLineRequestSchema)) body: AddReceiptLineRequest,
  ): Promise<Receipt> {
    return this.receipts.addLine(user, receiptId, body);
  }

  @Delete(':receiptId/lines/:lineId')
  removeLine(
    @CurrentUser() user: AuthUser,
    @Param('receiptId', UUID_PARAM) receiptId: string,
    @Param('lineId', UUID_PARAM) lineId: string,
  ): Promise<Receipt> {
    return this.receipts.removeLine(user, receiptId, lineId);
  }

  @Post(':receiptId/approve')
  @HttpCode(200)
  approve(
    @CurrentUser() user: AuthUser,
    @Param('receiptId', UUID_PARAM) receiptId: string,
    @Body(new ZodValidationPipe(approveReceiptRequestSchema)) body: ApproveReceiptRequest,
  ): Promise<Receipt> {
    return this.receipts.approve(user, receiptId, body);
  }
}
