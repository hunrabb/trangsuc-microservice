import { type AuthUser, CurrentUser, Roles, ZodValidationPipe } from '@jewelry/common';
import {
  type CreateMetalPriceRequest,
  createMetalPriceRequestSchema,
  type CreateMetalRequest,
  createMetalRequestSchema,
  type Metal,
  type MetalPrice,
  type MetalPricePage,
  type PaginationQuery,
  paginationQuerySchema,
} from '@jewelry/contracts';
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { UUID_PARAM } from '../common/uuid-param';
import { MetalsService } from './metals.service';

/** Cửa vào HTTP của kim loại và giá. Xem docs/api/inventory.openapi.yaml. */
@Controller('admin/metals')
export class MetalsController {
  constructor(private readonly metals: MetalsService) {}

  @Get()
  list(): Promise<Metal[]> {
    return this.metals.list();
  }

  @Roles('ADMIN')
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createMetalRequestSchema)) body: CreateMetalRequest,
  ): Promise<Metal> {
    return this.metals.create(user.id, body);
  }

  @Get(':metalId/price')
  currentPrice(@Param('metalId', UUID_PARAM) metalId: string): Promise<MetalPrice> {
    return this.metals.currentPrice(metalId);
  }

  @Get(':metalId/prices')
  history(
    @Param('metalId', UUID_PARAM) metalId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<MetalPricePage> {
    return this.metals.history(metalId, query);
  }

  @Roles('ADMIN')
  @Post(':metalId/prices')
  createPrice(
    @CurrentUser() user: AuthUser,
    @Param('metalId', UUID_PARAM) metalId: string,
    @Body(new ZodValidationPipe(createMetalPriceRequestSchema)) body: CreateMetalPriceRequest,
  ): Promise<MetalPrice> {
    return this.metals.createPrice(user.id, metalId, body);
  }
}
