CREATE TABLE "auth"."CustomerAccount" (
 "id" UUID PRIMARY KEY, "email" TEXT NOT NULL UNIQUE CHECK ("email" = lower("email")),
 "fullName" TEXT NOT NULL, "passwordHash" TEXT NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "auth"."CustomerSession" (
 "id" UUID PRIMARY KEY, "accountId" UUID NOT NULL REFERENCES "auth"."CustomerAccount"("id"),
 "tokenHash" TEXT NOT NULL UNIQUE, "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "sessionStartedAt" TIMESTAMPTZ(3) NOT NULL, "revokedAt" TIMESTAMPTZ(3)
);
CREATE INDEX "CustomerSession_accountId_idx" ON "auth"."CustomerSession"("accountId");
