import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import { postgresUrlField } from '@jewelry/common';
import { orderPaidPayloadSchema } from '@jewelry/contracts';
import { z } from 'zod';
import { PrismaClient } from '../generated/prisma/client';
import { historicalOrder } from '../backfill/historical-orders';

/** Một batch đọc Sales; --to bắt buộc để giới hạn cửa sổ khi tiếp tục bằng cursor. */
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      after: { type: 'string' },
      'batch-size': { type: 'string', default: '100' },
      output: { type: 'string' },
    },
  });
  const from = new Date(z.iso.datetime().parse(values.from));
  const to = new Date(z.iso.datetime().parse(values.to));
  if (from >= to || to.getTime() > Date.now())
    throw new Error('Cần from < to <= hiện tại (UTC ISO)');
  const batchSize = z.coerce.number().int().min(1).max(500).parse(values['batch-size']);
  const after = values.after === undefined ? undefined : z.uuid().parse(values.after);
  const output = z.string().min(1).parse(values.output);
  try {
    process.loadEnvFile('.env');
  } catch {
    /* container dùng env */
  }
  const connectionString = postgresUrlField('sales').parse(process.env.DATABASE_URL);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 2 }, { schema: 'sales' }),
  });
  try {
    // Phạm vi theo lịch sử nhận tiền. Đơn chưa có mốc COMPLETED được khám phá theo
    // ngày tạo để audit NOT_PAID/thiếu lịch sử, không suy diễn ngày nhận tiền cho chúng.
    const orders = await prisma.order.findMany({
      where: {
        OR: [
          { history: { some: { toStatus: 'COMPLETED', createdAt: { gte: from, lt: to } } } },
          { createdAt: { gte: from, lt: to }, history: { none: { toStatus: 'COMPLETED' } } },
        ],
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      include: { items: true, history: true },
    });
    const events = await prisma.outboxEvent.findMany({
      where: {
        eventType: 'order.paid',
        aggregateType: 'Order',
        aggregateId: { in: orders.map((order) => order.id) },
      },
      orderBy: { createdAt: 'asc' },
      select: { aggregateId: true, payload: true },
    });
    const rows = orders.map((order) => {
      const paid = events
        .filter((event) => event.aggregateId === order.id)
        .map((event) => orderPaidPayloadSchema.safeParse(event.payload))
        .find(
          (event) =>
            event.success &&
            event.data.orderId === order.id &&
            event.data.branchId === order.branchId &&
            new Date(event.data.paidAt) <= to,
        );
      return historicalOrder(order, paid?.success ? paid.data.paidAt : undefined);
    });
    await writeFile(
      output,
      rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''),
      { flag: 'wx', mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        mode: 'EXPORT_READ_ONLY',
        from: from.toISOString(),
        to: to.toISOString(),
        scanned: rows.length,
        eligible: rows.filter((row) => 'envelope' in row).length,
        excluded: rows.filter((row) => 'reason' in row).length,
        nextCursor: orders.at(-1)?.id ?? after ?? null,
        possiblyMore: orders.length === batchSize,
        output,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Export thất bại');
  process.exitCode = 1;
});
