import type { AuthUser } from '@jewelry/common';
import type { Item, ItemPage, ItemWithPrice, ListItemsQuery } from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { findCurrentPrice, priceNotSet } from '../catalog/metals.service';
import { assertListScope, assertRoleAtBranch, hasRoleAtBranch } from '../common/branch-access';
import { notFound, pageArgs } from '../common/errors';
import { computeItemPrice } from '../pricing/pricing';

const WITH_DETAIL = {
  warehouse: { select: { branchId: true } },
  variant: { include: { product: { select: { name: true } }, metal: { select: { name: true } } } },
} as const satisfies Prisma.JewelryItemInclude;

type ItemRow = Prisma.JewelryItemGetPayload<{ include: typeof WITH_DETAIL }>;

const VIEW_ROLES = ['MANAGER', 'STAFF'] as const;

/** Giá vốn chỉ ADMIN và MANAGER của chi nhánh thấy. */
const toItem = (row: ItemRow, user: AuthUser): Item => ({
  id: row.id,
  tagCode: row.tagCode,
  branchId: row.warehouse.branchId,
  variantId: row.variantId,
  sku: row.variant.sku,
  productName: row.variant.product.name,
  variantName: row.variant.name,
  metalName: row.variant.metal.name,
  weight: row.weight.toFixed(4),
  laborFee: row.laborFee.toFixed(2),
  costPrice: hasRoleAtBranch(user, row.warehouse.branchId, ['MANAGER'])
    ? row.costPrice.toFixed(2)
    : null,
  status: row.status,
  version: row.version,
});

/** Tồn kho = số chiếc `IN_STOCK`. Chỉ đọc nên không có tình huống đồng thời cần xử lý. */
@Injectable()
export class StockService {
  constructor(private readonly prisma: PrismaService) {}

  /** Danh sách chiếc theo chi nhánh, lọc theo biến thể và trạng thái. Không bao giờ trả chi nhánh khác. */
  async list(
    user: AuthUser,
    { branchId, variantId, status, ...paging }: ListItemsQuery,
  ): Promise<ItemPage> {
    assertListScope(user, branchId, VIEW_ROLES);
    const where: Prisma.JewelryItemWhereInput = {
      ...(branchId === undefined ? {} : { warehouse: { branchId } }),
      ...(variantId === undefined ? {} : { variantId }),
      ...(status === undefined ? {} : { status }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.jewelryItem.findMany({
        where,
        include: WITH_DETAIL,
        orderBy: { tagCode: 'asc' },
        ...pageArgs(paging),
      }),
      this.prisma.jewelryItem.count({ where }),
    ]);
    return { items: rows.map((row) => toItem(row, user)), total, ...paging };
  }

  /** Tra theo mã tem kèm giá hiện tại (`computeItemPrice`). Kim loại chưa có giá → `409 METAL_PRICE_NOT_SET`. */
  async byTag(user: AuthUser, tagCode: string): Promise<ItemWithPrice> {
    const row = await this.prisma.jewelryItem.findUnique({
      where: { tagCode },
      include: WITH_DETAIL,
    });
    if (row === null) {
      throw notFound('món hàng');
    }
    assertRoleAtBranch(user, row.warehouse.branchId, VIEW_ROLES);
    const current = await findCurrentPrice(this.prisma, row.variant.metalId);
    if (current === undefined) {
      throw priceNotSet();
    }
    const price = computeItemPrice(row.weight, current.sellPrice, row.laborFee);
    return {
      ...toItem(row, user),
      sellPricePerChi: current.sellPrice.toFixed(2),
      price: price.toFixed(2),
    };
  }
}
