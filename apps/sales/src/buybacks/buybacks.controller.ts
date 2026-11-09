import { CurrentUser, Roles, ZodValidationPipe, type AuthUser } from '@jewelry/common';
import {
  buybackQuerySchema,
  cancelBuybackSchema,
  createBuybackSchema,
  idempotencyKeySchema,
  submitBuybackSchema,
  updateBuybackSchema,
  type BuybackQuery,
  type CancelBuyback,
  type CreateBuyback,
  type SubmitBuyback,
  type UpdateBuyback,
} from '@jewelry/contracts';
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { BuybacksService } from './buybacks.service';

@Roles('ADMIN', 'MANAGER', 'STAFF')
@Controller('admin/branches/:branchId/buybacks')
export class BuybacksController {
  constructor(private readonly buybacks: BuybacksService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  create(
    @CurrentUser() user: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Headers('idempotency-key') key: unknown,
    @Body(new ZodValidationPipe(createBuybackSchema)) body: CreateBuyback,
  ) {
    return this.buybacks.create(
      user,
      branchId,
      new ZodValidationPipe(idempotencyKeySchema).transform(key),
      body,
    );
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentUser() user: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Query(new ZodValidationPipe(buybackQuerySchema)) query: BuybackQuery,
  ) {
    return this.buybacks.list(user, branchId, query);
  }

  @Get('by-key')
  @Header('Cache-Control', 'no-store')
  byKey(
    @CurrentUser() user: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.buybacks.byKey(
      user,
      branchId,
      new ZodValidationPipe(idempotencyKeySchema).transform(key),
    );
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  detail(
    @CurrentUser() user: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.buybacks.detail(user, branchId, id);
  }

  @Put(':id')
  @Header('Cache-Control', 'no-store')
  update(
    @CurrentUser() user: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateBuybackSchema)) body: UpdateBuyback,
  ) {
    return this.buybacks.update(user, branchId, id, body);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  submit(
    @CurrentUser() user: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(submitBuybackSchema)) body: SubmitBuyback,
  ) {
    return this.buybacks.submit(user, branchId, id, body.version);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(cancelBuybackSchema)) body: CancelBuyback,
  ) {
    return this.buybacks.cancel(user, branchId, id, body.version, body.reason);
  }
}
