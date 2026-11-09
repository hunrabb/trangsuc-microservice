import { BusinessError } from '@jewelry/common';
import { shopPageSchema, shopProductSchema, type ShopQuery } from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Missing/stale availability fails closed; catalog never reserves a physical item. */
export function isAvailable(available: number, capturedAt: Date, now = Date.now()): boolean {
  return available > 0 && capturedAt.getTime() >= now - 120_000 && capturedAt.getTime() <= now;
}
@Injectable()
export class PublicCatalogService {
  constructor(private readonly prisma: PrismaService) {}
  async list(q: ShopQuery) {
    // Sort/filter by the cheapest matching variant; price arithmetic remains in Inventory.
    const predicates = [
      Prisma.sql`p."isActive" = true`,
      Prisma.sql`p."capturedAt" >= now() - interval '2 minutes'`,
    ];
    if (q.categoryId) predicates.push(Prisma.sql`p."categoryId" = ${q.categoryId}::uuid`);
    if (q.search) {
      const pattern = '%' + q.search.replace(/[\\%_]/g, '\\$&') + '%';
      predicates.push(
        Prisma.sql`(p."name" ILIKE ${pattern} OR EXISTS (SELECT 1 FROM "sales"."CatalogVariant" s WHERE s."productId" = p.id AND s.sku ILIKE ${pattern}))`,
      );
    }
    const variantPredicates = [Prisma.sql`v."productId" = p.id`];
    if (q.metalKind) variantPredicates.push(Prisma.sql`v."metalKind" = ${q.metalKind}`);
    if (q.minPrice)
      variantPredicates.push(Prisma.sql`v."estimatedPrice" >= ${q.minPrice}::numeric`);
    if (q.maxPrice)
      variantPredicates.push(Prisma.sql`v."estimatedPrice" <= ${q.maxPrice}::numeric`);
    const base = Prisma.sql`FROM "sales"."CatalogProduct" p JOIN LATERAL
      (SELECT min(v."estimatedPrice") AS price FROM "sales"."CatalogVariant" v WHERE ${Prisma.join(variantPredicates, ' AND ')} HAVING count(*) > 0) prices ON true
      WHERE ${Prisma.join(predicates, ' AND ')}`;
    const order =
      q.sort === 'price_asc'
        ? Prisma.sql`prices.price ASC NULLS LAST`
        : q.sort === 'price_desc'
          ? Prisma.sql`prices.price DESC NULLS LAST`
          : Prisma.sql`p.name ASC`;
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT p.id ${base} ORDER BY ${order}, p.id ASC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
        );
        const [count] = await tx.$queryRaw<{ total: bigint }[]>(
          Prisma.sql`SELECT count(*) AS total ${base}`,
        );
        const items = [];
        for (const row of rows) items.push(await this.read(tx, row.id));
        return shopPageSchema.parse({
          items,
          total: Number(count!.total),
          page: q.page,
          pageSize: q.pageSize,
        });
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async detail(id: string) {
    return this.prisma.$transaction((tx) => this.read(tx, id), {
      isolationLevel: 'RepeatableRead',
    });
  }
  private async read(tx: Prisma.TransactionClient, id: string) {
    const p = await tx.catalogProduct.findFirst({
      where: { id, isActive: true, capturedAt: { gte: new Date(Date.now() - 120_000) } },
      include: { variants: { orderBy: { sku: 'asc' }, take: 200 } },
    });
    if (!p) throw new BusinessError('NOT_FOUND', 'Không tìm thấy sản phẩm', 404);
    const availability = await tx.catalogAvailability.findMany({
      where: { variantId: { in: p.variants.map((v) => v.id) } },
    });
    const variants = p.variants.map((v) => {
      const a = availability.find((a) => a.variantId === v.id);
      return {
        id: v.id,
        sku: v.sku,
        name: v.name,
        metalKind: v.metalKind,
        estimatedPrice: v.estimatedPrice?.toFixed(2) ?? null,
        inStock:
          v.estimatedPrice !== null &&
          a !== undefined &&
          a.version === p.version &&
          isAvailable(a.available, a.capturedAt),
      };
    });
    return shopProductSchema.parse({
      id: p.id,
      categoryId: p.categoryId,
      categoryName: p.categoryName,
      name: p.name,
      description: p.description,
      imageUrl: p.imageUrl,
      capturedAt: p.capturedAt.toISOString(),
      variants,
      inStock: variants.some((v) => v.inStock),
    });
  }
}
