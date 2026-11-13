import { BusinessError } from '@jewelry/common';
import { buybackSettledEventSchema, buybackStockedEventSchema } from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface Filter {
  from: string;
  to: string;
  branchId?: string;
}
const zero = () => new Prisma.Decimal(0);
const maxRows = 10_000;

function matches(
  settlement: { snapshot: unknown; branchId: string },
  stock: { snapshot: unknown; branchId: string },
) {
  const a = buybackSettledEventSchema.safeParse(settlement.snapshot);
  const b = buybackStockedEventSchema.safeParse(stock.snapshot);
  if (
    !a.success ||
    !b.success ||
    settlement.branchId !== stock.branchId ||
    a.data.approvedAmount !== b.data.approvedAmount ||
    a.data.lines.length !== b.data.items.length
  )
    return false;
  const stocked = new Map(b.data.items.map((item) => [item.quoteLineId, item]));
  return a.data.lines.every((line) => {
    const item = stocked.get(line.quoteLineId);
    return (
      item &&
      item.intakeItemId === line.intakeItemId &&
      item.metalId === line.metalId &&
      item.metalKind === line.metalKind &&
      item.acceptedWeight === line.acceptedWeight &&
      item.purityPerMille === line.purityPerMille &&
      item.amount === line.amount
    );
  });
}

@Injectable()
export class BuybackReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(filter: Filter) {
    const branch = filter.branchId ? { branchId: filter.branchId } : {};
    const [settlements, stocked] = await Promise.all([
      this.prisma.buybackSettlementFact.findMany({
        where: { ...branch, localDate: { gte: filter.from, lte: filter.to } },
        orderBy: [{ localDate: 'asc' }, { settlementId: 'asc' }],
        take: maxRows + 1,
      }),
      this.prisma.buybackStockFact.findMany({
        where: { ...branch, localDate: { gte: filter.from, lte: filter.to } },
        orderBy: [{ localDate: 'asc' }, { settlementId: 'asc' }],
        take: maxRows + 1,
      }),
    ]);
    if (settlements.length > maxRows || stocked.length > maxRows)
      throw new BusinessError(
        'PAYLOAD_TOO_LARGE',
        'Báo cáo thu mua quá lớn, hãy thu hẹp ngày/chi nhánh',
        413,
      );
    const [relatedStock, relatedSettlements, pendingMelt] = await Promise.all([
      this.prisma.buybackStockFact.findMany({
        where: { settlementId: { in: settlements.map((s) => s.settlementId) } },
      }),
      this.prisma.buybackSettlementFact.findMany({
        where: { settlementId: { in: stocked.map((s) => s.settlementId) } },
      }),
      this.prisma.buybackStockFact.aggregate({
        where: { ...branch, localDate: { lte: filter.to } },
        _sum: { costValue: true },
        _count: { _all: true },
      }),
    ]);
    const stockBySettlement = new Map(relatedStock.map((s) => [s.settlementId, s]));
    const settlementById = new Map(relatedSettlements.map((s) => [s.settlementId, s]));
    const days = new Map<
      string,
      {
        date: string;
        branchId: string;
        settlementCount: number;
        exchangeCount: number;
        expectedPieces: number;
        stockedReceipts: number;
        stockedPieces: number;
        purchaseValue: Prisma.Decimal;
        directPayout: Prisma.Decimal;
        exchangeCustomerPays: Prisma.Decimal;
        exchangeStorePays: Prisma.Decimal;
        receivedAssetValue: Prisma.Decimal;
      }
    >();
    const day = (date: string, branchId: string) => {
      const key = `${date}|${branchId}`;
      let row = days.get(key);
      if (!row) {
        row = {
          date,
          branchId,
          settlementCount: 0,
          exchangeCount: 0,
          expectedPieces: 0,
          stockedReceipts: 0,
          stockedPieces: 0,
          purchaseValue: zero(),
          directPayout: zero(),
          exchangeCustomerPays: zero(),
          exchangeStorePays: zero(),
          receivedAssetValue: zero(),
        };
        days.set(key, row);
      }
      return row;
    };
    const reconciliation: Array<{ settlementId: string; branchId: string; state: string }> = [];
    const reconciled = new Set<string>();
    for (const settlement of settlements) {
      const row = day(settlement.localDate, settlement.branchId);
      row.settlementCount++;
      row.expectedPieces += settlement.expectedItems;
      row.purchaseValue = row.purchaseValue.add(settlement.approvedAmount);
      if (settlement.kind === 'DIRECT')
        row.directPayout = row.directPayout.add(settlement.approvedAmount);
      else {
        row.exchangeCount++;
        if (settlement.direction === 'CUSTOMER_PAYS')
          row.exchangeCustomerPays = row.exchangeCustomerPays.add(settlement.amountDue);
        if (settlement.direction === 'STORE_PAYS')
          row.exchangeStorePays = row.exchangeStorePays.add(settlement.amountDue);
      }
      const stock = stockBySettlement.get(settlement.settlementId);
      if (!stock) {
        reconciled.add(settlement.settlementId);
        reconciliation.push({
          settlementId: settlement.settlementId,
          branchId: settlement.branchId,
          state: 'PENDING_STOCK',
        });
      } else if (!matches(settlement, stock)) {
        reconciled.add(settlement.settlementId);
        reconciliation.push({
          settlementId: settlement.settlementId,
          branchId: settlement.branchId,
          state: 'MISMATCH',
        });
      }
    }
    for (const stock of stocked) {
      const row = day(stock.localDate, stock.branchId);
      row.stockedReceipts++;
      row.stockedPieces += stock.itemCount;
      row.receivedAssetValue = row.receivedAssetValue.add(stock.costValue);
      const settlement = settlementById.get(stock.settlementId);
      if (!settlement)
        reconciliation.push({
          settlementId: stock.settlementId,
          branchId: stock.branchId,
          state: 'SETTLEMENT_EVENT_MISSING',
        });
      else if (!reconciled.has(stock.settlementId) && !matches(settlement, stock))
        reconciliation.push({
          settlementId: stock.settlementId,
          branchId: stock.branchId,
          state: 'MISMATCH',
        });
    }
    return {
      timezone: 'Asia/Ho_Chi_Minh',
      from: filter.from,
      to: filter.to,
      coverage: filter.branchId ? 'REQUESTED_BRANCH' : 'OBSERVED_BRANCHES_ONLY',
      currentPendingMeltValue: pendingMelt._sum.costValue?.toFixed(2) ?? '0.00',
      currentPendingMeltReceipts: pendingMelt._count._all,
      rows: [...days.values()]
        .sort((a, b) => a.date.localeCompare(b.date) || a.branchId.localeCompare(b.branchId))
        .map((row) => ({
          ...row,
          purchaseValue: row.purchaseValue.toFixed(2),
          directPayout: row.directPayout.toFixed(2),
          exchangeCustomerPays: row.exchangeCustomerPays.toFixed(2),
          exchangeStorePays: row.exchangeStorePays.toFixed(2),
          receivedAssetValue: row.receivedAssetValue.toFixed(2),
        })),
      reconciliation,
    };
  }
}
