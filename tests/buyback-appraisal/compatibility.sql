-- Run AFTER 7.1 and BEFORE 7.2 on the fresh isolated test database only.
BEGIN;
DO $$ BEGIN
 IF current_database()<>'phase72_test' OR current_user<>'sales_user' THEN RAISE EXCEPTION 'Only isolated phase72_test/sales_user'; END IF;
 IF EXISTS (SELECT FROM information_schema.columns WHERE table_schema='sales' AND table_name='BuybackIntake' AND column_name='activeQuoteId') THEN RAISE EXCEPTION 'Compatibility fixture must precede 7.2'; END IF;
END $$;
INSERT INTO sales."BuybackIntake" (id,code,"branchId","createdBy","idempotencyKey","requestHash","customerName","customerPhone",status,version,"submittedAt","cancelledAt","cancellationReason")
SELECT ('72000000-0000-4000-8000-00000000000'||n)::uuid,'PH72-COMPAT-'||n,
 '72000000-0000-4000-8000-000000000090','72000000-0000-4000-8000-000000000091',
 'PH72-COMPAT-'||n,repeat('a',64),'PH72 compatibility fixture','0901234567',
 CASE n WHEN 1 THEN 'DRAFT' WHEN 2 THEN 'PENDING_APPRAISAL' ELSE 'CANCELLED' END::sales."BuybackIntakeStatus",
 CASE n WHEN 1 THEN 1 ELSE 2 END,CASE WHEN n=2 THEN now() ELSE NULL END,
 CASE WHEN n=3 THEN now() ELSE NULL END,CASE WHEN n=3 THEN 'PH72 fixture cancelled' ELSE NULL END FROM generate_series(1,3) n;
INSERT INTO sales."BuybackIntakeItem" (id,"intakeId",position,source,"assetKind",description,condition,"declaredWeight","initialMeasuredWeight")
SELECT gen_random_uuid(),id,1,'EXTERNAL','GOLD','PH72 old item','PH72 old condition',1.2345,1.2000 FROM sales."BuybackIntake" WHERE code LIKE 'PH72-COMPAT-%';
INSERT INTO sales."BuybackIntakeAudit" (id,"intakeId","branchId","actorId",action,"toStatus","toVersion")
SELECT gen_random_uuid(),id,"branchId","createdBy",'CREATED','DRAFT',1 FROM sales."BuybackIntake" WHERE code LIKE 'PH72-COMPAT-%';
INSERT INTO sales."BuybackIntakeAudit" (id,"intakeId","branchId","actorId",action,"fromStatus","toStatus","fromVersion","toVersion")
SELECT gen_random_uuid(),id,"branchId","createdBy",CASE status WHEN 'PENDING_APPRAISAL' THEN 'SUBMITTED' ELSE 'CANCELLED' END::sales."BuybackAuditAction",'DRAFT',status,1,2 FROM sales."BuybackIntake" WHERE code LIKE 'PH72-COMPAT-%' AND version=2;
COMMIT;
