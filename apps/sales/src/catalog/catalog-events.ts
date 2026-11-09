import { PermanentError } from '@jewelry/common';
import {
  productSnapshotSchema,
  availabilitySnapshotSchema,
  ROUTING_KEYS,
} from '@jewelry/contracts';
import type { Prisma } from '../generated/prisma/client';

export async function onProductSnapshot(
  payload: unknown,
  { tx }: { tx: Prisma.TransactionClient },
): Promise<void> {
  const result = productSnapshotSchema.safeParse(payload);
  if (!result.success) throw new PermanentError('Invalid public product snapshot');
  const { variants, ...p } = result.data;
  // Atomic version gate serializes consumers; variants updated only for the winning snapshot.
  const changed = await tx.$executeRaw`
    INSERT INTO "sales"."CatalogProduct" ("id", "categoryId", "categoryName", "name", "description", "imageUrl", "isActive", "version", "capturedAt")
    VALUES (${p.id}::uuid, ${p.categoryId}::uuid, ${p.categoryName}, ${p.name}, ${p.description}, ${p.imageUrl}, ${p.isActive}, ${p.version}, ${new Date(p.capturedAt)})
    ON CONFLICT ("id") DO UPDATE SET "categoryId" = EXCLUDED."categoryId", "categoryName" = EXCLUDED."categoryName",
      "name" = EXCLUDED."name", "description" = EXCLUDED."description", "imageUrl" = EXCLUDED."imageUrl",
      "isActive" = EXCLUDED."isActive", "version" = EXCLUDED."version", "capturedAt" = EXCLUDED."capturedAt"
    WHERE "CatalogProduct"."version" < EXCLUDED."version"`;
  if (!changed) return;
  await tx.catalogVariant.deleteMany({ where: { productId: p.id } });
  if (variants.length)
    await tx.catalogVariant.createMany({ data: variants.map((v) => ({ ...v, productId: p.id })) });
}
export async function onAvailability(
  payload: unknown,
  { tx }: { tx: Prisma.TransactionClient },
): Promise<void> {
  const result = availabilitySnapshotSchema.safeParse(payload);
  if (!result.success) throw new PermanentError('Invalid public availability snapshot');
  const p = result.data;
  await tx.$executeRaw`
    INSERT INTO "sales"."CatalogAvailability" ("variantId", "available", "version", "capturedAt")
    VALUES (${p.variantId}::uuid, ${p.available}, ${p.version}, ${new Date(p.capturedAt)})
    ON CONFLICT ("variantId") DO UPDATE SET "available" = EXCLUDED."available", "version" = EXCLUDED."version", "capturedAt" = EXCLUDED."capturedAt"
    WHERE "CatalogAvailability"."version" < EXCLUDED."version"`;
}
export const CATALOG_HANDLERS = {
  // Binding có sẵn; Sales không tính giá. Inventory gửi product.snapshot sau khi tính lại.
  [ROUTING_KEYS.METAL_PRICE_CHANGED]: async () => {},
  [ROUTING_KEYS.PRODUCT_SNAPSHOT]: onProductSnapshot,
  [ROUTING_KEYS.STOCK_AVAILABILITY_CHANGED]: onAvailability,
};
