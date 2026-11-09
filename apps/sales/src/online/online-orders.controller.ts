import { Public, ZodValidationPipe } from '@jewelry/common';
import {
  checkoutAuthorizationSchema,
  createOnlineOrderSchema,
  idempotencyKeySchema,
  type CreateOnlineOrder,
} from '@jewelry/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Header,
} from '@nestjs/common';
import { OnlineOrdersService } from './online-orders.service';

@Public()
@Controller('shop/orders')
export class OnlineOrdersController {
  constructor(private readonly orders: OnlineOrdersService) {}
  private access(value: unknown): string {
    return new ZodValidationPipe(checkoutAuthorizationSchema).transform(value);
  }
  private key(value: unknown): string {
    return new ZodValidationPipe(idempotencyKeySchema).transform(value);
  }
  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  create(
    @Headers('authorization') authorization: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body(new ZodValidationPipe(createOnlineOrderSchema)) body: CreateOnlineOrder,
  ) {
    return this.orders.create(this.access(authorization), this.key(key), body);
  }
  @Get('by-key')
  @Header('Cache-Control', 'no-store')
  byKey(
    @Headers('authorization') authorization: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.orders.byKey(this.access(authorization), this.key(key));
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(
    @Headers('authorization') authorization: unknown,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.orders.get(this.access(authorization), id);
  }
  @Post(':id/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancel(
    @Headers('authorization') authorization: unknown,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.orders.cancel(this.access(authorization), id);
  }
}
