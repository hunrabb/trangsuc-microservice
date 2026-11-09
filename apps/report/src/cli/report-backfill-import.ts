import { parseArgs } from 'node:util';
import { postgresUrlField } from '@jewelry/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { z } from 'zod';
import { PrismaClient } from '../generated/prisma/client';
import { backfillOrder } from '../orders/historical-backfill';
import { importBackfillFile } from '../orders/backfill-file';

/** Chỉ nhập một batch; checkpoint sau audit, crash có thể chạy lại an toàn. */
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      input: { type: 'string' },
      audit: { type: 'string' },
      checkpoint: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'batch-size': { type: 'string', default: '100' },
    },
  });
  const input = z.string().min(1).parse(values.input);
  const audit = z.string().min(1).parse(values.audit);
  const checkpoint = z.string().min(1).parse(values.checkpoint);
  const limit = z.coerce.number().int().min(1).max(500).parse(values['batch-size']);
  try {
    process.loadEnvFile('.env');
  } catch {
    /* env được truyền bởi container */
  }
  const connectionString = postgresUrlField('report').parse(process.env.DATABASE_URL);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 2 }, { schema: 'report' }),
  });
  try {
    const summary = await importBackfillFile(
      { input, audit, checkpoint, apply: values.apply, batchSize: limit },
      (raw, apply) =>
        prisma.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
            await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
            if (!apply) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
            return backfillOrder(tx, raw, apply);
          },
          { timeout: 10_000 },
        ),
    );
    console.log(JSON.stringify(summary));
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Import thất bại');
  process.exitCode = 1;
});
