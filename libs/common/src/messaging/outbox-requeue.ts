import { parseArgs } from 'node:util';
import { z } from 'zod';
import { postgresUrlField } from '../config/env-fields';
import type { OutboxDb } from './outbox-worker';

export interface RequeueArgs {
  service: string;
  eventType?: string;
  id?: string;
  dryRun: boolean;
}

export interface RequeueFilter {
  eventType?: string;
  id?: string;
}

/** Đọc tham số dòng lệnh; sai thì ném lỗi có nội dung cho người chạy. `--` của pnpm bị bỏ qua. */
export function parseRequeueArgs(argv: readonly string[]): RequeueArgs {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: {
      service: { type: 'string' },
      'event-type': { type: 'string' },
      id: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (values.service === undefined || values.service === '') {
    throw new Error('Thiếu --service <tên>');
  }
  if (values.id !== undefined && !z.uuid().safeParse(values.id).success) {
    throw new Error(`--id không phải UUID: ${values.id}`);
  }
  return {
    service: values.service,
    eventType: values['event-type'],
    id: values.id,
    dryRun: values['dry-run'],
  };
}

const failedRows = (table: string) =>
  `FROM ${table} WHERE status = 'FAILED'
     AND ($1::text IS NULL OR "eventType" = $1)
     AND ($2::uuid IS NULL OR id = $2::uuid)`;

export async function countFailedEvents(
  db: OutboxDb,
  dbSchema: string,
  filter: RequeueFilter,
): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ count: bigint | number }[]>(
    `SELECT count(*) AS count ${failedRows(`"${dbSchema}"."OutboxEvent"`)}`,
    filter.eventType ?? null,
    filter.id ?? null,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Đưa dòng `FAILED` về `PENDING`, đặt lại `attempts`. Một câu UPDATE nên không có khoảng hở giữa đọc và ghi;
 * điều kiện `status = 'FAILED'` nằm trong WHERE nên không đụng tới dòng khác. Trả về số dòng đã đổi.
 */
export function requeueFailedEvents(
  db: OutboxDb,
  dbSchema: string,
  filter: RequeueFilter,
): Promise<number> {
  const table = `"${dbSchema}"."OutboxEvent"`;
  return db.$executeRawUnsafe(
    `UPDATE ${table}
     SET status = 'PENDING', attempts = 0, "nextAttemptAt" = NULL, "lockedUntil" = NULL, "updatedAt" = now()
     WHERE status = 'FAILED'
       AND ($1::text IS NULL OR "eventType" = $1)
       AND ($2::uuid IS NULL OR id = $2::uuid)`,
    filter.eventType ?? null,
    filter.id ?? null,
  );
}

export interface RequeueCliOptions {
  /** Tên service của app đang chạy. `--service` phải khớp, tránh chạy nhầm service. */
  service: string;
  dbSchema: string;
  createDb: (databaseUrl: string) => OutboxDb & { $disconnect(): Promise<void> };
}

function loadEnvFile(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // Trong container không có file .env: biến lấy từ môi trường.
  }
}

/** Thân lệnh chạy tay, dùng đúng `DATABASE_URL` (user DB) của service đó. */
export async function runOutboxRequeueCli(options: RequeueCliOptions): Promise<void> {
  const { service, dbSchema, createDb } = options;
  try {
    const args = parseRequeueArgs(process.argv.slice(2));
    if (args.service !== service) {
      throw new Error(`--service ${args.service} không khớp service đang chạy (${service})`);
    }
    loadEnvFile();
    const databaseUrl = postgresUrlField(dbSchema).parse(process.env.DATABASE_URL);
    const db = createDb(databaseUrl);
    try {
      const filter = { eventType: args.eventType, id: args.id };
      if (args.dryRun) {
        const count = await countFailedEvents(db, dbSchema, filter);
        console.log(`[dry-run] ${service}: sẽ đổi ${count} dòng FAILED → PENDING`);
      } else {
        const count = await requeueFailedEvents(db, dbSchema, filter);
        console.log(`${service}: đã đổi ${count} dòng FAILED → PENDING`);
      }
    } finally {
      await db.$disconnect();
    }
  } catch (error) {
    console.error(`LỖI: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
