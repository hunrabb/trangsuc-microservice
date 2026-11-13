import type { StockSummaryPage, StockSummaryQuery } from '@jewelry/contracts';
import { Prisma as Sql } from '../generated/prisma/client';
import type { AuthUser } from '@jewelry/common';
import type { Item, ItemLabel, ItemPage, ItemWithPrice, ListItemsQuery } from '@jewelry/contracts';
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

  /** Một snapshot SQL, mỗi chiếc chỉ xuất hiện một lần; EXISTS không nhân bản theo lịch sử giữ hàng. */
  async summary(user: AuthUser, query: StockSummaryQuery): Promise<StockSummaryPage> {
    assertListScope(user, query.branchId, VIEW_ROLES);
    const { branchId, variantId, page, pageSize } = query;
    const [result] = await this.prisma.$queryRaw<
      { items: StockSummaryPage['items']; total: number }[]
    >(Sql.sql`
      WITH classified AS (
        SELECT i.*, w."branchId", w.name AS "branchName",
          v.sku, v.name AS "variantName", p.name AS "productName", m.name AS "metalName",
          (w."isActive" AND v."isActive" AND p."isActive" AND c."isActive" AND m."isActive" AND EXISTS (
            SELECT 1 FROM "inventory"."MetalPrice" mp
            WHERE mp."metalId" = m.id AND mp."effectiveFrom" <= now()
          )) AS enabled,
          (
            EXISTS (
              SELECT 1 FROM "inventory"."StockReservationItem" ri
              JOIN "inventory"."StockReservation" r ON r.id = ri."reservationId"
              WHERE ri."jewelryItemId" = i.id AND ri."isActive"
                AND r.status IN ('ACTIVE', 'PAID_HELD') AND r."expiresAt" > now()
            ) OR EXISTS (
              SELECT 1 FROM "inventory"."ExchangeHold" h
              WHERE h."itemId" = i.id AND h.status IN ('ACTIVE', 'PROTECTED')
                AND h."expiresAt" > now()
            )
          ) AS held
        FROM "inventory"."JewelryItem" i
        JOIN "inventory"."Warehouse" w ON w.id = i."warehouseId"
        JOIN "inventory"."ProductVariant" v ON v.id = i."variantId"
        JOIN "inventory"."Product" p ON p.id = v."productId"
        JOIN "inventory"."Category" c ON c.id = p."categoryId"
        JOIN "inventory"."Metal" m ON m.id = v."metalId"
        WHERE w."branchId" = ${branchId}::uuid
          ${variantId ? Sql.sql`AND i."variantId" = ${variantId}::uuid` : Sql.empty}
      ), grouped AS (
        SELECT "branchId", "branchName", "variantId", sku, "variantName", "productName", "metalName",
          count(*)::int AS total,
          count(*) FILTER (WHERE status = 'IN_STOCK' AND enabled)::int AS available,
          count(*) FILTER (WHERE status = 'RESERVED' AND held)::int AS reserved,
          count(*) FILTER (WHERE status = 'SOLD')::int AS sold,
          count(*) FILTER (WHERE status = 'PENDING_MELT')::int AS "pendingMelt",
          count(*) FILTER (WHERE (status = 'IN_STOCK' AND NOT enabled)
            OR (status = 'RESERVED' AND NOT held))::int AS other
        FROM classified
        GROUP BY "branchId", "branchName", "variantId", sku, "variantName", "productName", "metalName"
      ), paged AS (
        SELECT * FROM grouped ORDER BY "productName", sku, "variantId"
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      )
      SELECT COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY "productName", sku, "variantId") FROM paged), '[]'::jsonb) AS items,
        (SELECT count(*)::int FROM grouped) AS total
    `);
    return { items: result?.items ?? [], total: result?.total ?? 0, page, pageSize };
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

  /**
   * Dữ liệu tem của một chiếc: mã tem, tên mẫu, biến thể, trọng lượng, kim loại (tên đã gồm tuổi) và giá tạm tính.
   * Khác `byTag`: kim loại chưa có giá thì KHÔNG báo lỗi mà để giá là `null`, vì tem vẫn in được. Chỉ đọc.
   */
  async getLabel(user: AuthUser, tagCode: string): Promise<ItemLabel> {
    const row = await this.prisma.jewelryItem.findUnique({
      where: { tagCode },
      include: {
        warehouse: { select: { branchId: true } },
        variant: {
          include: {
            product: { select: { name: true } },
            metal: { select: { name: true, kind: true } },
          },
        },
      },
    });
    if (row === null) {
      throw notFound('món hàng');
    }
    assertRoleAtBranch(user, row.warehouse.branchId, VIEW_ROLES);
    const currentPrice = await findCurrentPrice(this.prisma, row.variant.metalId);
    return {
      tagCode: row.tagCode,
      productName: row.variant.product.name,
      variantName: row.variant.name,
      sku: row.variant.sku,
      metalName: row.variant.metal.name,
      metalKind: row.variant.metal.kind,
      weight: row.weight.toFixed(4),
      sellPricePerChi: currentPrice?.sellPrice.toFixed(2) ?? null,
      estimatedPrice:
        currentPrice === undefined
          ? null
          : computeItemPrice(row.weight, currentPrice.sellPrice, row.laborFee).toFixed(2),
    };
  }
}
