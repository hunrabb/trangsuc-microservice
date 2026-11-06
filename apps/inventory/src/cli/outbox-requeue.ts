import { type OutboxDb, runOutboxRequeueCli } from '@jewelry/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { DB_SCHEMA, SERVICE_NAME } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

// Lệnh chạy tay, gửi lại dòng outbox FAILED. Xem runbook "Thư outbox bị FAILED" trong README.
void runOutboxRequeueCli({
  service: SERVICE_NAME,
  dbSchema: DB_SCHEMA,
  createDb: (connectionString) =>
    new PrismaClient({
      adapter: new PrismaPg({ connectionString }, { schema: DB_SCHEMA }),
    }) as unknown as OutboxDb & { $disconnect(): Promise<void> },
});
