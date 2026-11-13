import { createHash } from 'node:crypto';
import { PermanentError } from '@jewelry/common';
import {
  buybackSettledEventSchema,
  buybackStockedEventSchema,
  type EventEnvelope,
} from '@jewelry/contracts';
import { Prisma } from '../generated/prisma/client';
import { vietnamDate } from '../orders/order-report.handler';

type Context = { tx: Prisma.TransactionClient; envelope: EventEnvelope };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money = (value: string) => new Prisma.Decimal(value);

export async function recordBuybackSettled(payload: unknown, { tx }: Context) {
  const parsed = buybackSettledEventSchema.safeParse(payload);
  if (!parsed.success) throw new PermanentError('Snapshot buyback.settled sai định dạng');
  const data = parsed.data;
  const lines = [...data.lines].sort((a, b) => a.quoteLineId.localeCompare(b.quoteLineId));
  if (
    new Set(lines.map((line) => line.quoteLineId)).size !== lines.length ||
    new Set(lines.map((line) => line.intakeItemId)).size !== lines.length ||
    lines.some(
      (line) =>
        money(line.acceptedWeight).lte(0) ||
        money(line.purityPerMille).lte(0) ||
        money(line.purityPerMille).gt(1000),
    ) ||
    !lines.reduce((sum, line) => sum.add(line.amount), money('0')).equals(data.approvedAmount)
  )
    throw new PermanentError('Snapshot buyback.settled có dòng/tổng không hợp lệ');
  if (
    (data.kind === 'DIRECT' &&
      (data.saleAmount !== null ||
        data.direction !== 'STORE_PAYS' ||
        !money(data.amountDue).equals(data.approvedAmount))) ||
    (data.kind === 'EXCHANGE' &&
      (data.saleAmount === null ||
        !money(data.saleAmount).minus(data.approvedAmount).abs().equals(data.amountDue) ||
        (money(data.saleAmount).gt(data.approvedAmount)
          ? 'CUSTOMER_PAYS'
          : money(data.saleAmount).lt(data.approvedAmount)
            ? 'STORE_PAYS'
            : 'NONE') !== data.direction))
  )
    throw new PermanentError('Tiền settlement không nhất quán');
  const canonical = { ...data, lines };
  const snapshotHash = digest(canonical);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('report.buyback.settled'),hashtext(${data.settlementId}))::text AS lock`;
  const existing = await tx.buybackSettlementFact.findUnique({
    where: { settlementId: data.settlementId },
  });
  if (existing) {
    if (existing.snapshotHash !== snapshotHash)
      throw new PermanentError('Settlement report đã có snapshot khác');
    return;
  }
  await tx.buybackSettlementFact.create({
    data: {
      settlementId: data.settlementId,
      intakeId: data.intakeId,
      quoteId: data.quoteId,
      branchId: data.branchId,
      kind: data.kind,
      localDate: vietnamDate(new Date(data.settledAt)),
      settledAt: new Date(data.settledAt),
      approvedAmount: data.approvedAmount,
      saleAmount: data.saleAmount,
      direction: data.direction,
      amountDue: data.amountDue,
      expectedItems: lines.length,
      snapshotHash,
      snapshot: canonical as Prisma.InputJsonValue,
    },
  });
}

export async function recordBuybackStocked(payload: unknown, { tx }: Context) {
  const parsed = buybackStockedEventSchema.safeParse(payload);
  if (!parsed.success) throw new PermanentError('Snapshot buyback.stocked sai định dạng');
  const data = parsed.data;
  const items = [...data.items].sort((a, b) => a.quoteLineId.localeCompare(b.quoteLineId));
  if (
    data.receiptId !== data.settlementId ||
    new Set(items.map((item) => item.quoteLineId)).size !== items.length ||
    new Set(items.map((item) => item.intakeItemId)).size !== items.length ||
    new Set(items.map((item) => item.tagCode)).size !== items.length ||
    items.some(
      (item) =>
        item.jewelryItemId !== item.quoteLineId ||
        item.tagCode !== `BB-${item.quoteLineId}` ||
        money(item.acceptedWeight).lte(0) ||
        money(item.purityPerMille).lte(0) ||
        money(item.purityPerMille).gt(1000),
    ) ||
    !items.reduce((sum, item) => sum.add(item.amount), money('0')).equals(data.approvedAmount)
  )
    throw new PermanentError('Snapshot buyback.stocked có nguồn/tổng không hợp lệ');
  const canonical = { ...data, items };
  const snapshotHash = digest(canonical);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('report.buyback.stocked'),hashtext(${data.settlementId}))::text AS lock`;
  const existing = await tx.buybackStockFact.findUnique({
    where: { settlementId: data.settlementId },
  });
  if (existing) {
    if (existing.snapshotHash !== snapshotHash)
      throw new PermanentError('Stock report đã có snapshot khác');
    return;
  }
  await tx.buybackStockFact.create({
    data: {
      settlementId: data.settlementId,
      branchId: data.branchId,
      warehouseId: data.warehouseId,
      receiptId: data.receiptId,
      localDate: vietnamDate(new Date(data.receivedAt)),
      receivedAt: new Date(data.receivedAt),
      itemCount: items.length,
      costValue: data.approvedAmount,
      snapshotHash,
      snapshot: canonical as Prisma.InputJsonValue,
    },
  });
}
