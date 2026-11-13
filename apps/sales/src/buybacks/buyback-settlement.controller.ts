import { CurrentUser, Roles, ZodValidationPipe, type AuthUser } from '@jewelry/common';
import {
  createSettlementSchema,
  createExchangeSchema,
  recordSettlementPaymentSchema,
  confirmSettlementPaymentSchema,
  cancelSettlementSchema,
  idempotencyKeySchema,
  type CreateSettlement,
  type CreateExchange,
  type RecordSettlementPayment,
  type ConfirmSettlementPayment,
  type CancelSettlement,
} from '@jewelry/contracts';
import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  Headers,
  Header,
  HttpCode,
} from '@nestjs/common';
import { BuybackSettlementService } from './buyback-settlement.service';

const key = (input: unknown) => new ZodValidationPipe(idempotencyKeySchema).transform(input);
@Roles('ADMIN', 'MANAGER', 'STAFF')
@Controller('admin/branches/:branchId/buybacks')
export class BuybackSettlementController {
  constructor(private readonly service: BuybackSettlementService) {}
  @Post(':id/settlements')
  @Header('Cache-Control', 'no-store')
  create(
    @CurrentUser() u: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) b: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: unknown,
    @Body(new ZodValidationPipe(createSettlementSchema)) body: CreateSettlement,
  ) {
    return this.service.createDirect(u, b, id, key(k), body);
  }
  @Post(':id/exchanges')
  @Header('Cache-Control', 'no-store')
  exchange(
    @CurrentUser() u: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) b: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: unknown,
    @Body(new ZodValidationPipe(createExchangeSchema)) body: CreateExchange,
  ) {
    return this.service.createExchange(u, b, id, key(k), body);
  }
  @Get(':id/settlements')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentUser() u: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) b: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.get(u, b, id);
  }
  @Post(':id/settlements/:settlementId/payment')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  record(
    @CurrentUser() u: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) b: string,
    @Param('id', new ParseUUIDPipe()) intakeId: string,
    @Param('settlementId', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: unknown,
    @Body(new ZodValidationPipe(recordSettlementPaymentSchema)) body: RecordSettlementPayment,
  ) {
    return this.service.record(u, b, intakeId, id, key(k), body);
  }
  @Post(':id/settlements/:settlementId/confirm')
  @Roles('ADMIN', 'MANAGER')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  confirm(
    @CurrentUser() u: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) b: string,
    @Param('id', new ParseUUIDPipe()) intakeId: string,
    @Param('settlementId', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: unknown,
    @Body(new ZodValidationPipe(confirmSettlementPaymentSchema)) body: ConfirmSettlementPayment,
  ) {
    return this.service.confirm(u, b, intakeId, id, key(k), body);
  }
  @Post(':id/settlements/:settlementId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancel(
    @CurrentUser() u: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) b: string,
    @Param('id', new ParseUUIDPipe()) intakeId: string,
    @Param('settlementId', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') k: unknown,
    @Body(new ZodValidationPipe(cancelSettlementSchema)) body: CancelSettlement,
  ) {
    return this.service.cancel(u, b, intakeId, id, key(k), body);
  }
}
