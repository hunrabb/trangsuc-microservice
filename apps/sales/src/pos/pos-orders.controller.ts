import { type AuthUser, CurrentUser, ZodValidationPipe } from '@jewelry/common';
import {
  type CreatePosOrderRequest,
  createPosOrderRequestSchema,
  idempotencyKeySchema,
  type PosOrder,
} from '@jewelry/contracts';
import { Body, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PosOrdersService } from './pos-orders.service';

/** Cửa vào POS chỉ kiểm dữ liệu; service kiểm quyền trên chi nhánh thật của từng hoá đơn. */
@Controller('pos/orders')
export class PosOrdersController {
  constructor(private readonly orders: PosOrdersService) {}

  /** Tạo hoặc phát lại hoá đơn bằng cùng key; không nhận giá hay trạng thái từ client. */
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key: unknown,
    @Body(new ZodValidationPipe(createPosOrderRequestSchema)) body: CreatePosOrderRequest,
  ): Promise<PosOrder> {
    const checkedKey = new ZodValidationPipe(idempotencyKeySchema).transform(key);
    return this.orders.create(user, checkedKey, body);
  }

  /** Nhân viên xác nhận nhận tiền chuyển khoản; trạng thái DB chống xác nhận trùng. */
  @Post(':id/confirm-payment')
  @HttpCode(200)
  confirmPayment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PosOrder> {
    return this.orders.confirmPayment(user, id);
  }

  /** Huỷ đơn chờ trả tiền; lần retry tiếp tục trả kho nếu cuộc gọi trước bị gián đoạn. */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<PosOrder> {
    return this.orders.cancel(user, id);
  }
}
