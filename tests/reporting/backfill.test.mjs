import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  appRequire,
  reportRequire,
  client,
  fixtureOrder,
  cleanupOrders,
  databaseUrl,
  root,
} from './support.mjs';
const { historicalOrder } = appRequire('sales')('./dist/backfill/historical-orders.js');
const { backfillOrder } = reportRequire('./dist/orders/historical-backfill.js');
const { recordPaidOrder } = reportRequire('./dist/orders/order-report.handler.js');

test('PostgreSQL: live/backfill song song, duplicate, conflict, CLI dry-run/checkpoint và batch cursor', async () => {
  const sales = client('sales');
  const report = client('report');
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const branchId = randomUUID();
  const eventIds = [];
  const directory = await mkdtemp(join(tmpdir(), 'phase54-'));
  function cli(service, script, args) {
    const result = spawnSync(process.execPath, [`dist/cli/${script}.js`, ...args], {
      cwd: resolve(root, `apps/${service}`),
      env: { ...process.env, DATABASE_URL: databaseUrl(service) },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  }
  try {
    for (const id of ids) await sales.order.create({ data: fixtureOrder(id, branchId) });
    const order = await sales.order.findUniqueOrThrow({
      where: { id: ids[0] },
      include: { items: true, history: true },
    });
    const row = historicalOrder(order);
    eventIds.push(row.envelope.eventId);
    const liveId = randomUUID();
    eventIds.push(liveId);
    assert.equal((await report.$transaction((tx) => backfillOrder(tx, row))).status, 'NEEDED');
    assert.equal(await report.orderRevenue.count({ where: { orderId: row.orderId } }), 0);
    const rollbackSource = await sales.order.findUniqueOrThrow({
      where: { id: ids[1] },
      include: { items: true, history: true },
    });
    const rollbackRow = historicalOrder(rollbackSource);
    eventIds.push(rollbackRow.envelope.eventId);
    await assert.rejects(
      () =>
        report.$transaction(async (tx) => {
          await backfillOrder(tx, rollbackRow, true);
          throw new Error('PH55 controlled rollback');
        }),
      /PH55 controlled rollback/,
    );
    assert.equal(await report.orderRevenue.count({ where: { orderId: rollbackRow.orderId } }), 0);
    assert.equal(await report.orderLineSales.count({ where: { orderId: rollbackRow.orderId } }), 0);
    assert.equal(
      await report.processedEvent.count({ where: { eventId: rollbackRow.envelope.eventId } }),
      0,
    );
    await Promise.all([
      report.$transaction((tx) => backfillOrder(tx, row, true)),
      report.$transaction(async (tx) => {
        await tx.processedEvent.create({ data: { eventId: liveId, consumer: 'report' } });
        await recordPaidOrder(row.envelope.payload, {
          tx,
          envelope: { ...row.envelope, eventId: liveId },
        });
      }),
    ]);
    assert.equal(
      (await report.$transaction((tx) => backfillOrder(tx, row, true))).status,
      'EXISTS',
    );
    assert.equal(await report.orderRevenue.count({ where: { orderId: row.orderId } }), 1);
    assert.equal(await report.orderLineSales.count({ where: { orderId: row.orderId } }), 1);
    const changed = structuredClone(row);
    changed.envelope.payload.items[0].costPrice = null;
    assert.equal(
      (await report.$transaction((tx) => backfillOrder(tx, changed, true))).status,
      'CONFLICT',
    );
    assert.equal(
      (
        await report.orderRevenue.findUniqueOrThrow({ where: { orderId: row.orderId } })
      ).cogs.toFixed(2),
      '80000.00',
    );
    const input = join(directory, 'fixture.jsonl');
    const rows = [];
    for (const id of ids.slice(1)) {
      const source = await sales.order.findUniqueOrThrow({
        where: { id },
        include: { items: true, history: true },
      });
      const exported = historicalOrder(source);
      rows.push(exported);
      eventIds.push(exported.envelope.eventId);
    }
    await writeFile(input, rows.map((item) => JSON.stringify(item)).join('\n') + '\n');
    const args = [
      '--input',
      input,
      '--audit',
      join(directory, 'dry.audit'),
      '--checkpoint',
      join(directory, 'dry.cursor'),
      '--batch-size',
      '1',
    ];
    const dry = cli('report', 'report-backfill-import', args);
    assert.equal(dry.counts.NEEDED, 1);
    assert.equal(dry.nextLine, 1);
    assert.equal(await report.orderRevenue.count({ where: { orderId: { in: ids.slice(1) } } }), 0);
    const applyArgs = [
      '--input',
      input,
      '--apply',
      '--audit',
      join(directory, 'apply.audit'),
      '--checkpoint',
      join(directory, 'apply.cursor'),
      '--batch-size',
      '1',
    ];
    assert.equal(cli('report', 'report-backfill-import', applyArgs).nextLine, 1);
    assert.equal(cli('report', 'report-backfill-import', applyArgs).nextLine, 2);
    assert.equal(cli('report', 'report-backfill-import', applyArgs).processed, 0);
    assert.equal(
      (await readFile(join(directory, 'apply.audit'), 'utf8')).trim().split('\n').length,
      2,
    );
    // Cursor export: chỉ cửa sổ test vừa tạo, mỗi batch một đơn, ID tăng dần.
    const from = new Date(order.createdAt.getTime() - 1000).toISOString();
    const to = new Date().toISOString();
    let cursor;
    const seen = [];
    for (let index = 0; index < 4; index++) {
      const output = join(directory, `export-${index}.jsonl`);
      const result = cli('sales', 'report-backfill-export', [
        '--from',
        from,
        '--to',
        to,
        '--batch-size',
        '1',
        '--output',
        output,
        ...(cursor ? ['--after', cursor] : []),
      ]);
      if (!result.scanned) break;
      seen.push(JSON.parse((await readFile(output, 'utf8')).trim()).orderId);
      cursor = result.nextCursor;
    }
    assert.deepEqual(seen.sort(), [...ids].sort());
    const totals = await report.orderRevenue.aggregate({
      where: { orderId: { in: ids } },
      _sum: { revenue: true, cogs: true },
    });
    assert.equal(totals._sum.revenue.toFixed(2), '300000.00');
    assert.equal(totals._sum.cogs.toFixed(2), '240000.00');
  } finally {
    await cleanupOrders(sales, report, ids, eventIds);
    await Promise.all([sales.$disconnect(), report.$disconnect()]);
  }
});
