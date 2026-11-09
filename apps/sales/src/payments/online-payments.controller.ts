import { CurrentUser, Roles, ZodValidationPipe, type AuthUser } from '@jewelry/common';
import {
  confirmOnlinePaymentSchema,
  idempotencyKeySchema,
  requestOnlineRefundSchema,
  type ConfirmOnlinePayment,
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
} from '@nestjs/common';
import { OnlinePaymentsService } from './online-payments.service';

@Roles('ADMIN', 'MANAGER')
@Controller('admin/branches/:branchId/online-orders/:orderId/payments')
export class OnlinePaymentsController {
  constructor(private readonly payments: OnlinePaymentsService) {}
  @Post('confirm')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Headers('idempotency-key') key: unknown,
    @Body(new ZodValidationPipe(confirmOnlinePaymentSchema)) body: ConfirmOnlinePayment,
  ) {
    return this.payments.confirm(
      user,
      branchId,
      orderId,
      new ZodValidationPipe(idempotencyKeySchema).transform(key),
      body,
    );
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentUser() user: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.payments.list(user, branchId, orderId);
  }
  @Post(':paymentId/refund-request')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  requestRefund(
    @CurrentUser() user: AuthUser,
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Body(new ZodValidationPipe(requestOnlineRefundSchema)) body: { reason: string },
  ) {
    return this.payments.requestRefund(user, branchId, orderId, paymentId, body.reason);
  }
}
