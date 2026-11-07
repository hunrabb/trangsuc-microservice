import { type AuthUser, CurrentUser, ZodValidationPipe } from '@jewelry/common';
import {
  type ItemPage,
  type ItemWithPrice,
  type ListItemsQuery,
  listItemsQuerySchema,
} from '@jewelry/contracts';
import { Controller, Get, Param, Query } from '@nestjs/common';
import { StockService } from './stock.service';

/** Cửa vào HTTP của tồn kho. Quyền theo chi nhánh kiểm trong service. */
@Controller('admin/items')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listItemsQuerySchema)) query: ListItemsQuery,
  ): Promise<ItemPage> {
    return this.stock.list(user, query);
  }

  @Get('by-tag/:tagCode')
  byTag(@CurrentUser() user: AuthUser, @Param('tagCode') tagCode: string): Promise<ItemWithPrice> {
    return this.stock.byTag(user, tagCode);
  }
}
