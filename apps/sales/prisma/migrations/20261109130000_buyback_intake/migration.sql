-- Additive intake-only schema. No payment/Inventory writes, no existing table rewrite.
CREATE TYPE "sales"."BuybackIntakeStatus" AS ENUM ('DRAFT','PENDING_APPRAISAL','CANCELLED');
CREATE TYPE "sales"."BuybackAssetKind" AS ENUM ('GOLD','SILVER','JEWELRY');
CREATE TYPE "sales"."BuybackItemSource" AS ENUM ('STORE_TAG','EXTERNAL');
CREATE TYPE "sales"."BuybackAuditAction" AS ENUM ('CREATED','UPDATED','SUBMITTED','CANCELLED');
CREATE TABLE "sales"."BuybackIntake" (
 "id" UUID PRIMARY KEY, "code" TEXT NOT NULL UNIQUE, "branchId" UUID NOT NULL, "createdBy" UUID NOT NULL,
 "idempotencyKey" TEXT NOT NULL, "requestHash" TEXT NOT NULL,
 "customerId" UUID REFERENCES "sales"."Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "customerName" TEXT NOT NULL, "customerPhone" TEXT NOT NULL, "notes" TEXT,
 "status" "sales"."BuybackIntakeStatus" NOT NULL DEFAULT 'DRAFT', "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version">0),
 "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "submittedAt" TIMESTAMPTZ(3), "cancelledAt" TIMESTAMPTZ(3), "cancellationReason" TEXT,
 CONSTRAINT "BuybackIntake_branchId_createdBy_idempotencyKey_key" UNIQUE ("branchId","createdBy","idempotencyKey"),
 CONSTRAINT "BuybackIntake_lifecycle_fields" CHECK (
  ("status"='DRAFT' AND "submittedAt" IS NULL AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL) OR
  ("status"='PENDING_APPRAISAL' AND "submittedAt" IS NOT NULL AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL) OR
  ("status"='CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL AND length(trim("cancellationReason"))>=5)));
CREATE INDEX "BuybackIntake_branchId_status_receivedAt_id_idx" ON "sales"."BuybackIntake"("branchId","status","receivedAt","id");
CREATE INDEX "BuybackIntake_branchId_receivedAt_id_idx" ON "sales"."BuybackIntake"("branchId","receivedAt","id");
CREATE INDEX "BuybackIntake_customerId_idx" ON "sales"."BuybackIntake"("customerId");
CREATE TABLE "sales"."BuybackIntakeItem" (
 "id" UUID PRIMARY KEY, "intakeId" UUID NOT NULL REFERENCES "sales"."BuybackIntake"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "position" INTEGER NOT NULL CHECK ("position" BETWEEN 1 AND 20), "source" "sales"."BuybackItemSource" NOT NULL,
 "referenceTagCode" TEXT, "assetKind" "sales"."BuybackAssetKind" NOT NULL, "description" TEXT NOT NULL, "condition" TEXT NOT NULL,
 "declaredWeight" DECIMAL(12,4) CHECK ("declaredWeight">0), "initialMeasuredWeight" DECIMAL(12,4) CHECK ("initialMeasuredWeight">0),
 "declaredPurity" TEXT, "notes" TEXT,
 CONSTRAINT "BuybackIntakeItem_intakeId_position_key" UNIQUE ("intakeId","position"),
 CONSTRAINT "BuybackIntakeItem_source_reference" CHECK (
  ("source"='STORE_TAG' AND "referenceTagCode" IS NOT NULL AND length(trim("referenceTagCode"))>0) OR
  ("source"='EXTERNAL' AND "referenceTagCode" IS NULL)));
CREATE TABLE "sales"."BuybackIntakeAudit" (
 "id" UUID PRIMARY KEY, "intakeId" UUID NOT NULL REFERENCES "sales"."BuybackIntake"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "branchId" UUID NOT NULL, "actorId" UUID NOT NULL, "action" "sales"."BuybackAuditAction" NOT NULL,
 "fromStatus" "sales"."BuybackIntakeStatus", "toStatus" "sales"."BuybackIntakeStatus" NOT NULL,
 "fromVersion" INTEGER, "toVersion" INTEGER NOT NULL CHECK ("toVersion">0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "BuybackIntakeAudit_intakeId_toVersion_key" UNIQUE ("intakeId","toVersion"),
 CONSTRAINT "BuybackIntakeAudit_versions" CHECK (
  ("action"='CREATED' AND "fromVersion" IS NULL AND "fromStatus" IS NULL AND "toVersion"=1 AND "toStatus"='DRAFT') OR
  ("action"<>'CREATED' AND "fromVersion" IS NOT NULL AND "fromStatus" IS NOT NULL AND "fromVersion">0 AND "toVersion"="fromVersion"+1)));
