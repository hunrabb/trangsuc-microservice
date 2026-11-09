CREATE TYPE "report"."DlqReplayStatus" AS ENUM
  ('REQUESTED', 'REPUBLISHED', 'PUBLISH_FAILED', 'PUBLISH_UNCONFIRMED', 'PROCESSING_FAILED');

CREATE TABLE "report"."DeadLetterRecord" (
  "id" UUID NOT NULL PRIMARY KEY,
  "sourceQueue" TEXT NOT NULL,
  "sourceService" TEXT NOT NULL,
  "routingKey" TEXT,
  "eventType" TEXT,
  "eventId" UUID,
  "correlationId" TEXT,
  "failureKind" TEXT NOT NULL,
  "failureReason" TEXT NOT NULL,
  "retryCount" INTEGER,
  "content" BYTEA NOT NULL,
  "failedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "replayCount" INTEGER NOT NULL DEFAULT 0,
  "replayLeaseUntil" TIMESTAMPTZ(3)
);
CREATE INDEX "DeadLetterRecord_failedAt_id_idx" ON "report"."DeadLetterRecord"("failedAt", "id");
CREATE INDEX "DeadLetterRecord_sourceService_failedAt_idx" ON "report"."DeadLetterRecord"("sourceService", "failedAt");
CREATE INDEX "DeadLetterRecord_eventType_failedAt_idx" ON "report"."DeadLetterRecord"("eventType", "failedAt");

CREATE TABLE "report"."DlqReplayAttempt" (
  "id" UUID NOT NULL PRIMARY KEY,
  "recordId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "status" "report"."DlqReplayStatus" NOT NULL DEFAULT 'REQUESTED',
  "failureCode" TEXT,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMPTZ(3),
  CONSTRAINT "DlqReplayAttempt_recordId_fkey" FOREIGN KEY ("recordId")
    REFERENCES "report"."DeadLetterRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "DlqReplayAttempt_recordId_requestedAt_idx" ON "report"."DlqReplayAttempt"("recordId", "requestedAt");
