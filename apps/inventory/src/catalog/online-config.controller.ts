import { BusinessError, Roles, ZodValidationPipe } from '@jewelry/common';
import {
  onlineWarehouseSchema,
  onlineBufferSchema,
  type OnlineWarehouse,
  type OnlineBuffer,
} from '@jewelry/contracts';
import { Body, Controller, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Roles('ADMIN')
@Controller('admin/online-catalog')
export class OnlineConfigController {
  constructor(private readonly prisma: PrismaService) {}
  @Put('warehouses/:warehouseId')
  async warehouse(
    @Param('warehouseId', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(onlineWarehouseSchema)) body: OnlineWarehouse,
  ) {
    if (!(await this.prisma.warehouse.count({ where: { id } })))
      throw new BusinessError('NOT_FOUND', 'Không có kho', 404);
    const row = await this.prisma.warehouse.update({
      where: { id },
      data: body,
      select: { id: true, acceptsOnlineOrders: true },
    });
    return row;
  }
  @Put('warehouses/:warehouseId/buffers/:variantId')
  async buffer(
    @Param('warehouseId', new ParseUUIDPipe()) warehouseId: string,
    @Param('variantId', new ParseUUIDPipe()) variantId: string,
    @Body(new ZodValidationPipe(onlineBufferSchema)) body: OnlineBuffer,
  ) {
    const [warehouse, variant] = await Promise.all([
      this.prisma.warehouse.count({ where: { id: warehouseId } }),
      this.prisma.productVariant.count({ where: { id: variantId } }),
    ]);
    if (!warehouse || !variant)
      throw new BusinessError('NOT_FOUND', 'Không có kho hoặc biến thể', 404);
    return this.prisma.onlineStockBuffer.upsert({
      where: { warehouseId_variantId: { warehouseId, variantId } },
      create: { warehouseId, variantId, ...body },
      update: body,
    });
  }
}
