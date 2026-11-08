import { type AuthUser, CurrentUser } from '@jewelry/common';
import type { ItemLabel } from '@jewelry/contracts';
import { Controller, Get, Param } from '@nestjs/common';
import { StockService } from './stock.service';

/** Dữ liệu để in tem. Chỉ trả JSON; frontend dựng tem. */
@Controller('admin/jewelry-items')
export class LabelController {
  constructor(private readonly stock: StockService) {}

  @Get(':tagCode/label')
  label(@CurrentUser() user: AuthUser, @Param('tagCode') tagCode: string): Promise<ItemLabel> {
    return this.stock.getLabel(user, tagCode);
  }
}
