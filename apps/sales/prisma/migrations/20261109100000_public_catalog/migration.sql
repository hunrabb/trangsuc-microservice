CREATE TABLE "sales"."CatalogProduct" (
 "id" UUID PRIMARY KEY, "categoryId" UUID NOT NULL, "categoryName" TEXT NOT NULL,
 "name" TEXT NOT NULL, "description" TEXT, "imageUrl" TEXT, "isActive" BOOLEAN NOT NULL,
 "version" INTEGER NOT NULL, "capturedAt" TIMESTAMPTZ(3) NOT NULL);
CREATE INDEX "CatalogProduct_isActive_categoryId_name_idx" ON "sales"."CatalogProduct"("isActive", "categoryId", "name");
CREATE TABLE "sales"."CatalogVariant" ("id" UUID PRIMARY KEY, "productId" UUID NOT NULL REFERENCES "sales"."CatalogProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "sku" TEXT NOT NULL, "name" TEXT NOT NULL, "metalKind" TEXT NOT NULL,
 "estimatedPrice" DECIMAL(20,2));
CREATE INDEX "CatalogVariant_productId_idx" ON "sales"."CatalogVariant"("productId");
CREATE TABLE "sales"."CatalogAvailability" ("variantId" UUID PRIMARY KEY, "available" INTEGER NOT NULL CHECK ("available" >= 0),
 "version" INTEGER NOT NULL, "capturedAt" TIMESTAMPTZ(3) NOT NULL);
