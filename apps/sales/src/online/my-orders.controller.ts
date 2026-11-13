import { Audience, CurrentUser, ZodValidationPipe, type AuthUser } from '@jewelry/common';
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
  Query,
} from '@nestjs/common';
import {
  createOnlineOrderSchema,
  checkoutAuthorizationSchema,
  idempotencyKeySchema,
  type CreateOnlineOrder,
} from '@jewelry/contracts';
import { z } from 'zod';
import { OnlineOrdersService } from './online-orders.service';
const pagination = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

@Audience('shop')
@Controller('shop/my-orders')
export class MyOrdersController {
  constructor(private readonly orders: OnlineOrdersService) {}
  @Header('Cache-Control', 'no-store')
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(pagination)) query: z.infer<typeof pagination>,
  ) {
    return this.orders.forAccount(user.id, query.page, query.pageSize);
  }
  @Header('Cache-Control', 'no-store')
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.orders.accountOrder(user.id, id);
  }
  @Header('Cache-Control', 'no-store')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.orders.cancelAccount(user.id, id);
  }
  @Header('Cache-Control', 'no-store')
  @Post()
  @HttpCode(202)
  create(
    @CurrentUser() user: AuthUser,
    @Headers('x-checkout-authorization') access: unknown,
    @Headers('idempotency-key') key: unknown,
    @Body(new ZodValidationPipe(createOnlineOrderSchema)) body: CreateOnlineOrder,
  ) {
    return this.orders.create(
      new ZodValidationPipe(checkoutAuthorizationSchema).transform(access),
      new ZodValidationPipe(idempotencyKeySchema).transform(key),
      body,
      user.id,
    );
  }
}
