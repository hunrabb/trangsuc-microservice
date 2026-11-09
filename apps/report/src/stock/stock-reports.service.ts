import { BusinessError } from '@jewelry/common';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface StockFilter {
  from: string;
  to: string;
  branchId?: string;
}
type Snapshot = Awaited<ReturnType<PrismaService['inventorySnapshot']['findMany']>>[number];

/** Liệt kê ngày UTC tương ứng nhãn ngày Việt Nam, không dùng phép cộng millisecond theo giờ máy. */
function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  let current = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (current <= end) {
    dates.push(new Date(current).toISOString().slice(0, 10));
    current += 86_400_000;
  }
  return dates;
}

function previousDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** Cộng số chiếc, chỉ và giá vốn bằng Decimal để không sai số khi nhiều biến thể. */
function amount(quantity: number, weight: Prisma.Decimal, value: Prisma.Decimal) {
  return { pieces: quantity, chi: weight.toFixed(4), costValue: value.toFixed(2) };
}

function zero() {
  return new Prisma.Decimal(0);
}

@Injectable()
export class StockReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Trả bản chốt nguyên gốc và thời điểm thực chụp; thiếu snapshot được báo công khai. */
  async snapshots(date: string, branchId?: string) {
    const batches = await this.prisma.inventorySnapshotBatch.findMany({
      where: { localDate: date, ...(branchId ? { branchId } : {}) },
      include: { rows: { orderBy: { sku: 'asc' } } },
      orderBy: { branchId: 'asc' },
    });
    return {
      timezone: 'Asia/Ho_Chi_Minh',
      date,
      complete: branchId ? batches.length > 0 : null,
      warehouses: batches.map((batch) => ({
        branchId: batch.branchId,
        warehouseId: batch.warehouseId,
        capturedAt: batch.capturedAt.toISOString(),
        rows: batch.rows.map((row) => ({
          variantId: row.variantId,
          sku: row.sku,
          metalId: row.metalId,
          metalCode: row.metalCode,
          metalKind: row.metalKind,
          onHand: amount(row.onHand, row.weight, row.value),
        })),
      })),
    };
  }

  /** Chỉ trả số liệu kho có đủ mốc liên tiếp; thiếu ngày hay lệch sổ kho thì báo incomplete. */
  async movements(filter: StockFilter, maxSnapshotRows?: number) {
    const openingDate = previousDate(filter.from);
    const days = datesBetween(openingDate, filter.to);
    const where = {
      localDate: { gte: openingDate, lte: filter.to },
      ...(filter.branchId ? { branchId: filter.branchId } : {}),
    };
    if (maxSnapshotRows !== undefined) {
      const [snapshotCount, batchCount] = await Promise.all([
        this.prisma.inventorySnapshot.count({ where: { batch: where } }),
        this.prisma.inventorySnapshotBatch.count({ where }),
      ]);
      if (snapshotCount > maxSnapshotRows || batchCount > maxSnapshotRows) {
        throw new BusinessError('PAYLOAD_TOO_LARGE', 'Báo cáo quá lớn, hãy thu hẹp bộ lọc', 413);
      }
    }
    const batches = await this.prisma.inventorySnapshotBatch.findMany({
      where,
      include: { rows: true },
      orderBy: [{ branchId: 'asc' }, { warehouseId: 'asc' }, { localDate: 'asc' }],
    });
    if (
      maxSnapshotRows !== undefined &&
      (batches.length > maxSnapshotRows ||
        batches.reduce((count, batch) => count + batch.rows.length, 0) > maxSnapshotRows)
    ) {
      throw new BusinessError('PAYLOAD_TOO_LARGE', 'Báo cáo quá lớn, hãy thu hẹp bộ lọc', 413);
    }
    if (filter.branchId && batches.length === 0) {
      return {
        timezone: 'Asia/Ho_Chi_Minh',
        from: filter.from,
        to: filter.to,
        coverage: 'REQUESTED_BRANCH',
        warehouses: [
          {
            branchId: filter.branchId,
            warehouseId: null,
            complete: false,
            reason: 'MISSING_SNAPSHOT',
            missingDates: days,
            rows: [],
          },
        ],
      };
    }
    const warehouseIds = [...new Set(batches.map((batch) => batch.warehouseId))];
    const warehouses = warehouseIds.map((warehouseId) => {
      const own = batches.filter((batch) => batch.warehouseId === warehouseId);
      const byDate = new Map(own.map((batch) => [batch.localDate, batch]));
      const missingDates = days.filter((day) => !byDate.has(day));
      const brokenLinks = days.slice(1).some((day, index) => {
        const current = byDate.get(day);
        const previous = byDate.get(days[index]!);
        return (
          current &&
          previous &&
          current.previousCapturedAt?.getTime() !== previous.capturedAt.getTime()
        );
      });
      if (missingDates.length || brokenLinks) {
        return {
          branchId: own[0]!.branchId,
          warehouseId,
          complete: false,
          reason: brokenLinks ? 'BROKEN_SNAPSHOT_CHAIN' : 'MISSING_SNAPSHOT',
          missingDates,
          rows: [],
        };
      }
      const rows = this.calculateRows(own, openingDate, filter.to);
      const reconciled = rows.every((row) => row.reconciled);
      return {
        branchId: own[0]!.branchId,
        warehouseId,
        complete: reconciled,
        reason: reconciled ? null : 'RECONCILIATION_FAILED',
        missingDates: [],
        rows: reconciled
          ? rows.map((row) => ({
              variantId: row.variantId,
              sku: row.sku,
              metalId: row.metalId,
              metalCode: row.metalCode,
              metalKind: row.metalKind,
              opening: row.opening,
              received: row.received,
              released: row.released,
              sold: row.sold,
              closing: row.closing,
            }))
          : [],
      };
    });
    return {
      timezone: 'Asia/Ho_Chi_Minh',
      from: filter.from,
      to: filter.to,
      coverage: filter.branchId ? 'REQUESTED_BRANCH' : 'OBSERVED_WAREHOUSES_ONLY',
      warehouses,
    };
  }

  /** Ghép tồn mở/đóng và movement đã chốt; COUNT_MISSING không làm giảm tồn thực tế. */
  private calculateRows(
    batches: Array<{ localDate: string; rows: Snapshot[] }>,
    openingDate: string,
    closingDate: string,
  ) {
    const opening = new Map(
      batches
        .find((batch) => batch.localDate === openingDate)!
        .rows.map((row) => [row.variantId, row]),
    );
    const closing = new Map(
      batches
        .find((batch) => batch.localDate === closingDate)!
        .rows.map((row) => [row.variantId, row]),
    );
    const periodRows = batches
      .filter((batch) => batch.localDate !== openingDate)
      .flatMap((batch) => batch.rows);
    const variants = new Map<string, Snapshot>();
    for (const row of [...opening.values(), ...periodRows, ...closing.values()])
      variants.set(row.variantId, row);
    return [...variants.entries()].map(([variantId, metadata]) => {
      const first = opening.get(variantId);
      const last = closing.get(variantId);
      const movements = periodRows.filter((row) => row.variantId === variantId);
      const sum = (
        field:
          | 'receivedWeight'
          | 'receivedValue'
          | 'releasedWeight'
          | 'releasedValue'
          | 'soldWeight'
          | 'soldValue',
      ) => movements.reduce((value, row) => value.plus(row[field]), zero());
      const count = (field: 'received' | 'released' | 'sold') =>
        movements.reduce((value, row) => value + row[field], 0);
      const received = amount(count('received'), sum('receivedWeight'), sum('receivedValue'));
      const released = amount(count('released'), sum('releasedWeight'), sum('releasedValue'));
      const sold = amount(count('sold'), sum('soldWeight'), sum('soldValue'));
      const start = amount(first?.onHand ?? 0, first?.weight ?? zero(), first?.value ?? zero());
      const end = amount(last?.onHand ?? 0, last?.weight ?? zero(), last?.value ?? zero());
      const reconciled =
        start.pieces + received.pieces + released.pieces - sold.pieces === end.pieces &&
        new Prisma.Decimal(start.chi)
          .plus(received.chi)
          .plus(released.chi)
          .minus(sold.chi)
          .equals(end.chi) &&
        new Prisma.Decimal(start.costValue)
          .plus(received.costValue)
          .plus(released.costValue)
          .minus(sold.costValue)
          .equals(end.costValue);
      return {
        variantId,
        sku: metadata.sku,
        metalId: metadata.metalId,
        metalCode: metadata.metalCode,
        metalKind: metadata.metalKind,
        opening: start,
        received,
        released,
        sold,
        closing: end,
        reconciled,
      };
    });
  }
}
