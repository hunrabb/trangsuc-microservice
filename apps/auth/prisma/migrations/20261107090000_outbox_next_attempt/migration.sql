-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "nextAttemptAt" TIMESTAMPTZ(3);
