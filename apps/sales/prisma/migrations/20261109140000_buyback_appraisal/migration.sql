-- Additive Task 7.2. Historical intake rows remain valid; no payment/stock mutation.
ALTER TYPE "sales"."BuybackIntakeStatus" ADD VALUE 'APPRAISED';
ALTER TYPE "sales"."BuybackIntakeStatus" ADD VALUE 'APPROVED';
ALTER TYPE "sales"."BuybackIntakeStatus" ADD VALUE 'REJECTED';
ALTER TYPE "sales"."BuybackAuditAction" ADD VALUE 'APPRAISED';
ALTER TYPE "sales"."BuybackAuditAction" ADD VALUE 'QUOTED';
ALTER TYPE "sales"."BuybackAuditAction" ADD VALUE 'APPROVED';
ALTER TYPE "sales"."BuybackAuditAction" ADD VALUE 'REJECTED';
ALTER TABLE "sales"."BuybackIntake" ADD COLUMN "activeQuoteId" UUID;
ALTER TABLE "sales"."BuybackIntake" DROP CONSTRAINT "BuybackIntake_lifecycle_fields";
ALTER TABLE "sales"."BuybackIntake" ADD CONSTRAINT "BuybackIntake_lifecycle_fields" CHECK (
 ("status"::text='DRAFT' AND "submittedAt" IS NULL AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL AND "activeQuoteId" IS NULL) OR
 ("status"::text IN ('PENDING_APPRAISAL','APPRAISED','APPROVED','REJECTED') AND "submittedAt" IS NOT NULL AND "cancelledAt" IS NULL AND "cancellationReason" IS NULL AND ("status"::text NOT IN ('APPROVED','REJECTED') OR "activeQuoteId" IS NOT NULL)) OR
 ("status"::text='CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL AND length(trim("cancellationReason"))>=5 AND "activeQuoteId" IS NULL));

CREATE TABLE "sales"."BuybackAppraisal" (
 "id" UUID PRIMARY KEY, "intakeId" UUID NOT NULL REFERENCES "sales"."BuybackIntake"("id") ON DELETE RESTRICT,
 "itemId" UUID NOT NULL REFERENCES "sales"."BuybackIntakeItem"("id") ON DELETE RESTRICT,
 "intakeVersion" INTEGER NOT NULL CHECK ("intakeVersion">0),
 "measuredWeight" DECIMAL(12,4) NOT NULL CHECK ("measuredWeight">0),
 "acceptedWeight" DECIMAL(12,4) NOT NULL CHECK ("acceptedWeight">0 AND "acceptedWeight"<="measuredWeight"),
 "metalId" UUID NOT NULL, "metalKind" TEXT NOT NULL CHECK ("metalKind" IN ('GOLD','SILVER')),
 "purityPerMille" DECIMAL(8,4) NOT NULL CHECK ("purityPerMille">0 AND "purityPerMille"<=1000),
 "condition" TEXT NOT NULL CHECK (length(trim("condition")) BETWEEN 1 AND 1000), "notes" TEXT,
 "appraisedBy" UUID NOT NULL, "appraisedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("itemId","intakeVersion"));
CREATE INDEX "BuybackAppraisal_intakeId_itemId_intakeVersion_idx" ON "sales"."BuybackAppraisal"("intakeId","itemId","intakeVersion");
CREATE TABLE "sales"."BuybackPricePolicy" (
 "id" UUID PRIMARY KEY, "branchId" UUID NOT NULL, "metalId" UUID NOT NULL,
 "metalKind" TEXT NOT NULL CHECK ("metalKind" IN ('GOLD','SILVER')),
 "purityPerMille" DECIMAL(8,4) NOT NULL CHECK ("purityPerMille">0 AND "purityPerMille"<=1000),
 "label" TEXT NOT NULL CHECK (length(trim("label")) BETWEEN 1 AND 150),
 "deductionVndPerItem" DECIMAL(15,2) NOT NULL CHECK ("deductionVndPerItem">=0),
 "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version">0), "isActive" BOOLEAN NOT NULL DEFAULT true,
 "createdBy" UUID NOT NULL, "idempotencyKey" TEXT NOT NULL, "requestHash" TEXT NOT NULL,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "BuybackPricePolicy_branchId_createdBy_idempotencyKey_key" UNIQUE ("branchId","createdBy","idempotencyKey"));
CREATE INDEX "BuybackPricePolicy_branchId_isActive_id_idx" ON "sales"."BuybackPricePolicy"("branchId","isActive","id");
CREATE TABLE "sales"."BuybackPolicyAudit" (
 "id" UUID PRIMARY KEY, "policyId" UUID NOT NULL REFERENCES "sales"."BuybackPricePolicy"("id") ON DELETE RESTRICT,
 "version" INTEGER NOT NULL CHECK ("version">0), "actorId" UUID NOT NULL,
 "reason" TEXT NOT NULL CHECK (length(trim("reason")) BETWEEN 5 AND 500), "snapshot" JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE ("policyId","version"));
CREATE TABLE "sales"."BuybackQuote" (
 "id" UUID PRIMARY KEY, "intakeId" UUID NOT NULL REFERENCES "sales"."BuybackIntake"("id") ON DELETE RESTRICT,
 "sourceVersion" INTEGER NOT NULL CHECK ("sourceVersion">0),
 "status" TEXT NOT NULL DEFAULT 'QUOTED' CHECK ("status" IN ('QUOTED','SUPERSEDED','APPROVED','REJECTED')),
 "currency" TEXT NOT NULL DEFAULT 'VND' CHECK ("currency"='VND'),
 "total" DECIMAL(20,2) NOT NULL CHECK ("total">=0),
 "rounding" TEXT NOT NULL CHECK ("rounding"='HALF_UP_1000_VND_PER_LINE'),
 "requireSeparateApprover" BOOLEAN NOT NULL DEFAULT true CHECK ("requireSeparateApprover"),
 "quotedBy" UUID NOT NULL, "quotedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "decidedBy" UUID, "decidedAt" TIMESTAMPTZ(3), "rejectionReason" TEXT,
 UNIQUE ("intakeId","id"),
 CHECK (("status" IN ('QUOTED','SUPERSEDED') AND "decidedBy" IS NULL AND "decidedAt" IS NULL AND "rejectionReason" IS NULL) OR
 ("status"='APPROVED' AND "decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL AND "rejectionReason" IS NULL) OR
 ("status"='REJECTED' AND "decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL AND "rejectionReason" IS NOT NULL AND length(trim("rejectionReason")) BETWEEN 5 AND 500)));
CREATE INDEX "BuybackQuote_intakeId_quotedAt_id_idx" ON "sales"."BuybackQuote"("intakeId","quotedAt","id");
CREATE UNIQUE INDEX "BuybackQuote_one_approved" ON "sales"."BuybackQuote"("intakeId") WHERE "status"='APPROVED';
CREATE UNIQUE INDEX "BuybackQuote_one_quoted" ON "sales"."BuybackQuote"("intakeId") WHERE "status"='QUOTED';
ALTER TABLE "sales"."BuybackIntake" ADD CONSTRAINT "BuybackIntake_activeQuote_fkey" FOREIGN KEY ("id","activeQuoteId") REFERENCES "sales"."BuybackQuote"("intakeId","id") ON DELETE RESTRICT;
CREATE TABLE "sales"."BuybackQuoteLine" (
 "id" UUID PRIMARY KEY, "quoteId" UUID NOT NULL REFERENCES "sales"."BuybackQuote"("id") ON DELETE RESTRICT,
 "itemId" UUID NOT NULL, "appraisalId" UUID NOT NULL REFERENCES "sales"."BuybackAppraisal"("id") ON DELETE RESTRICT,
 "appraisedBy" UUID NOT NULL, "measuredWeight" DECIMAL(12,4) NOT NULL CHECK ("measuredWeight">0),
 "acceptedWeight" DECIMAL(12,4) NOT NULL CHECK ("acceptedWeight">0 AND "acceptedWeight"<="measuredWeight"),
 "metalId" UUID NOT NULL, "metalKind" TEXT NOT NULL CHECK ("metalKind" IN ('GOLD','SILVER')),
 "purityPerMille" DECIMAL(8,4) NOT NULL CHECK ("purityPerMille">0 AND "purityPerMille"<=1000),
 "policyId" UUID NOT NULL REFERENCES "sales"."BuybackPricePolicy"("id") ON DELETE RESTRICT,
 "policyVersion" INTEGER NOT NULL CHECK ("policyVersion">0), "priceId" UUID NOT NULL, "metalCode" TEXT NOT NULL,
 "unit" TEXT NOT NULL CHECK ("unit"='VND_PER_CHI_ALLOY'), "unitPrice" DECIMAL(15,2) NOT NULL CHECK ("unitPrice">0),
 "effectiveFrom" TIMESTAMPTZ(3) NOT NULL, "capturedAt" TIMESTAMPTZ(3) NOT NULL CHECK ("effectiveFrom"<="capturedAt"),
 "deductionVndPerItem" DECIMAL(15,2) NOT NULL CHECK ("deductionVndPerItem">=0),
 "amount" DECIMAL(20,2) NOT NULL CHECK ("amount">=0 AND "acceptedWeight"*"unitPrice">="deductionVndPerItem" AND "amount"=round(("acceptedWeight"*"unitPrice"-"deductionVndPerItem")/1000,0)*1000),
 UNIQUE ("quoteId","itemId"));
CREATE TABLE "sales"."BuybackRequest" (
 "id" UUID PRIMARY KEY, "intakeId" UUID NOT NULL REFERENCES "sales"."BuybackIntake"("id") ON DELETE RESTRICT,
 "actorId" UUID NOT NULL, "idempotencyKey" TEXT NOT NULL, "requestHash" TEXT NOT NULL, "result" JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "BuybackRequest_intakeId_actorId_idempotencyKey_key" UNIQUE ("intakeId","actorId","idempotencyKey"));

-- Snapshot/revision data is append-only even when written outside application code.
CREATE FUNCTION "sales".buyback_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Immutable buyback revision/snapshot' USING ERRCODE='23514'; END $$;
CREATE TRIGGER buyback_appraisal_immutable BEFORE UPDATE OR DELETE ON "sales"."BuybackAppraisal" FOR EACH ROW EXECUTE FUNCTION "sales".buyback_immutable();
CREATE TRIGGER buyback_line_immutable BEFORE UPDATE OR DELETE ON "sales"."BuybackQuoteLine" FOR EACH ROW EXECUTE FUNCTION "sales".buyback_immutable();
CREATE TRIGGER buyback_policy_audit_immutable BEFORE UPDATE OR DELETE ON "sales"."BuybackPolicyAudit" FOR EACH ROW EXECUTE FUNCTION "sales".buyback_immutable();
CREATE FUNCTION "sales".buyback_header_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD."status"::text IN ('APPROVED','REJECTED') AND NEW IS DISTINCT FROM OLD THEN
 RAISE EXCEPTION 'Terminal buyback is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER buyback_header_guard BEFORE UPDATE ON "sales"."BuybackIntake" FOR EACH ROW EXECUTE FUNCTION "sales".buyback_header_guard();
CREATE FUNCTION "sales".buyback_appraisal_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS (SELECT FROM "sales"."BuybackIntakeItem" i JOIN "sales"."BuybackIntake" h ON h.id=i."intakeId" WHERE i.id=NEW."itemId" AND h.id=NEW."intakeId" AND h.status::text IN ('PENDING_APPRAISAL','APPRAISED')) THEN
 RAISE EXCEPTION 'Appraisal must belong to an editable submitted intake item' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER buyback_appraisal_guard BEFORE INSERT ON "sales"."BuybackAppraisal" FOR EACH ROW EXECUTE FUNCTION "sales".buyback_appraisal_guard();
CREATE FUNCTION "sales".buyback_quote_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status<>'QUOTED' OR (to_jsonb(NEW)-ARRAY['status','decidedBy','decidedAt','rejectionReason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','decidedBy','decidedAt','rejectionReason']) THEN
 RAISE EXCEPTION 'Quote snapshot is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.status='APPROVED' AND (NEW."decidedBy"=NEW."quotedBy" OR EXISTS (SELECT FROM "sales"."BuybackIntake" WHERE id=NEW."intakeId" AND "createdBy"=NEW."decidedBy") OR EXISTS (SELECT FROM "sales"."BuybackQuoteLine" WHERE "quoteId"=NEW.id AND "appraisedBy"=NEW."decidedBy")) THEN
 RAISE EXCEPTION 'Separate approver required' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER buyback_quote_guard BEFORE UPDATE ON "sales"."BuybackQuote" FOR EACH ROW EXECUTE FUNCTION "sales".buyback_quote_guard();
CREATE FUNCTION "sales".buyback_quote_total() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE q "sales"."BuybackQuote"; n integer; t numeric; qid uuid; BEGIN
 IF TG_TABLE_NAME='BuybackQuote' THEN qid=NEW.id; ELSE qid=NEW."quoteId"; END IF;
 SELECT * INTO q FROM "sales"."BuybackQuote" WHERE id=qid;
 SELECT count(*),sum(amount) INTO n,t FROM "sales"."BuybackQuoteLine" WHERE "quoteId"=qid;
 IF n<1 OR n<>(SELECT count(*) FROM "sales"."BuybackIntakeItem" WHERE "intakeId"=q."intakeId") OR t IS DISTINCT FROM q.total THEN
 RAISE EXCEPTION 'Quote lines/total mismatch' USING ERRCODE='23514'; END IF; RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER buyback_quote_total AFTER INSERT OR UPDATE ON "sales"."BuybackQuote" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "sales".buyback_quote_total();
CREATE CONSTRAINT TRIGGER buyback_line_total AFTER INSERT ON "sales"."BuybackQuoteLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "sales".buyback_quote_total();

CREATE FUNCTION "sales".buyback_line_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE a "sales"."BuybackAppraisal"; q "sales"."BuybackQuote"; p "sales"."BuybackPricePolicy"; BEGIN
 SELECT * INTO a FROM "sales"."BuybackAppraisal" WHERE id=NEW."appraisalId";
 SELECT * INTO q FROM "sales"."BuybackQuote" WHERE id=NEW."quoteId";
 SELECT * INTO p FROM "sales"."BuybackPricePolicy" WHERE id=NEW."policyId";
 IF a.id IS NULL OR q.id IS NULL OR p.id IS NULL OR q.status<>'QUOTED' OR q."intakeId"<>a."intakeId" OR
 (NEW."itemId",NEW."appraisedBy",NEW."measuredWeight",NEW."acceptedWeight",NEW."metalId",NEW."metalKind",NEW."purityPerMille") IS DISTINCT FROM
 (a."itemId",a."appraisedBy",a."measuredWeight",a."acceptedWeight",a."metalId",a."metalKind",a."purityPerMille") OR
 NOT p."isActive" OR p.version<>NEW."policyVersion" OR p."deductionVndPerItem"<>NEW."deductionVndPerItem" OR
 (p."metalId",p."metalKind",p."purityPerMille") IS DISTINCT FROM (a."metalId",a."metalKind",a."purityPerMille") OR
 NOT EXISTS (SELECT FROM "sales"."BuybackIntake" WHERE id=q."intakeId" AND "branchId"=p."branchId" AND status::text='APPRAISED') THEN
 RAISE EXCEPTION 'Quote line must match its appraisal and policy snapshot' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER buyback_line_source_guard BEFORE INSERT ON "sales"."BuybackQuoteLine" FOR EACH ROW EXECUTE FUNCTION "sales".buyback_line_source_guard();
