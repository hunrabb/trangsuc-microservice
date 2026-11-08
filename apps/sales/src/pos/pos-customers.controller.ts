import { type AuthUser, CurrentUser, ZodValidationPipe } from '@jewelry/common';
import {
  type CreatePosCustomerRequest,
  createPosCustomerRequestSchema,
  type PosCustomer,
  type PosCustomerOrders,
} from '@jewelry/contracts';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PosCustomersService } from './pos-customers.service';

/** Cửa vào khách hàng POS; mọi thao tác đều kiểm quyền theo branchId ở service. */
@Controller('pos/customers')
export class PosCustomersController {
  constructor(private readonly customers: PosCustomersService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createPosCustomerRequestSchema)) body: CreatePosCustomerRequest,
  ): Promise<PosCustomer> {
    return this.customers.createOrFind(user, body);
  }

  @Get('by-phone/:phone')
  findByPhone(
    @CurrentUser() user: AuthUser,
    @Param('phone') phone: string,
    @Query('branchId', ParseUUIDPipe) branchId: string,
  ): Promise<PosCustomer> {
    return this.customers.findByPhone(user, branchId, phone);
  }

  @Get(':id/orders')
  purchaseHistory(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) customerId: string,
    @Query('branchId', ParseUUIDPipe) branchId: string,
  ): Promise<PosCustomerOrders> {
    return this.customers.purchaseHistory(user, customerId, branchId);
  }
}
