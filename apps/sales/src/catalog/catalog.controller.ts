import { Public, ZodValidationPipe } from '@jewelry/common';
import { shopQuerySchema, type ShopQuery } from '@jewelry/contracts';
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PublicCatalogService } from './catalog.service';

@Public()
@Controller('shop/products')
export class PublicCatalogController {
  constructor(private readonly catalog: PublicCatalogService) {}
  @Get()
  list(@Query(new ZodValidationPipe(shopQuerySchema)) query: ShopQuery) {
    return this.catalog.list(query);
  }
  @Get(':productId')
  detail(@Param('productId', new ParseUUIDPipe()) id: string) {
    return this.catalog.detail(id);
  }
}
