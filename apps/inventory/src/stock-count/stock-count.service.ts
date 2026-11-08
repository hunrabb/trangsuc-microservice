import { randomBytes } from 'node:crypto';
import { type AuthUser, runWithLockRetry, violatedUniqueIndex } from '@jewelry/common';
import type {
  CreateStockCountRequest,
  ScanResult,
  ScanStockCountRequest,
  StockCountSummary,
} from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAudit } from '../common/audit';
import { assertRoleAtBranch } from '../common/branch-access';
import { invalidState, notFound } from '../common/errors';

type Transaction = Prisma.TransactionClient;

/** Ai được làm gì: chỉ MANAGER (và ADMIN) mở và đóng phiên; STAFF được quét và xem. */
const MANAGE_ROLES = ['MANAGER'] as const;
const SCAN_ROLES = ['MANAGER', 'STAFF'] as const;

const OPEN_SESSION_INDEX = 'StockCount_one_open_per_warehouse';
const STOCK_COUNT_REFERENCE = 'StockCount';

const newStockCountCode = (): string => {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `KK-${day}-${randomBytes(4).toString('hex').toUpperCase()}`;
};

/**
 * Kiểm kê kho: mở phiên (chụp danh sách chiếc dự kiến), quét từng chiếc, đóng phiên (chiếc không quét được là
 * thiếu). Phiên KHÔNG tự đổi trạng thái chiếc hàng: chiếc thiếu chỉ được đánh dấu trong phiên và ghi sổ kho
 * `COUNT_MISSING`; chiếc thừa chỉ liệt kê trong báo cáo. Người quản lý quyết định xử lý sau.
 */
@Injectable()
export class StockCountService {
  constructor(private readonly prisma: PrismaService) {}

  // ================================================================ mở phiên
  /**
   * Mở phiên kiểm kê cho kho của chi nhánh và chụp danh sách chiếc `IN_STOCK` lúc đó.
   * Đồng thời: mỗi kho tối đa MỘT phiên đang mở, do partial unique index làm trọng tài (hai quản lý bấm cùng lúc
   * thì một bên nhận `409`). Danh sách dự kiến chụp bằng MỘT câu `INSERT ... SELECT` nên nhất quán tại một thời điểm.
   */
  async createStockCount(
    user: AuthUser,
    request: CreateStockCountRequest,
  ): Promise<StockCountSummary> {
    assertRoleAtBranch(user, request.branchId, MANAGE_ROLES);
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { branchId: request.branchId },
    });
    if (warehouse === null) {
      throw notFound('kho của chi nhánh này');
    }
    if (!warehouse.isActive) {
      throw invalidState('Kho đã ngừng hoạt động');
    }
    const stockCountId = await this.openSession(user, warehouse.id);
    return this.buildSummary(this.prisma, stockCountId);
  }

  private async openSession(user: AuthUser, warehouseId: string): Promise<string> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const stockCount = await transaction.stockCount.create({
          data: { code: newStockCountCode(), warehouseId, createdBy: user.id },
        });
        await this.snapshotExpectedItems(transaction, stockCount.id, warehouseId);
        await writeAudit(transaction, {
          actorId: user.id,
          action: 'stock_count.opened',
          entityType: 'StockCount',
          entityId: stockCount.id,
          data: { code: stockCount.code },
        });
        return stockCount.id;
      });
    } catch (error) {
      if (violatedUniqueIndex(error) === OPEN_SESSION_INDEX) {
        throw invalidState('Kho này đang có một phiên kiểm kê chưa đóng');
      }
      throw error;
    }
  }

  /** Chép danh sách chiếc đang `IN_STOCK` của kho thành các dòng dự kiến. Không đổi trạng thái chiếc nào. */
  private async snapshotExpectedItems(
    transaction: Transaction,
    stockCountId: string,
    warehouseId: string,
  ): Promise<void> {
    await transaction.$executeRaw`
      INSERT INTO "inventory"."StockCountLine"
        ("id", "stockCountId", "jewelryItemId", "tagCode", "status", "updatedAt")
      SELECT gen_random_uuid(), ${stockCountId}::uuid, "id", "tagCode",
             'EXPECTED'::"inventory"."StockCountLineStatus", now()
      FROM "inventory"."JewelryItem"
      WHERE "warehouseId" = ${warehouseId}::uuid AND "status" = 'IN_STOCK'`;
  }

  // ================================================================ quét
  /**
   * Quét một mã tem. Chiếc dự kiến → `MATCHED`; quét lại → `ALREADY_SCANNED`; mã không thuộc danh sách dự kiến
   * → ghi vào danh sách thừa (`EXTRA`), KHÔNG tự thêm vào kho.
   * Đồng thời: nhiều người quét cùng lúc giữ khoá chia sẻ trên phiên (`FOR SHARE`) nên không chặn nhau; nhưng
   * `close` cần khoá độc quyền nên chờ các lần quét đang chạy xong, và quét sau khi phiên đóng nhận `409`.
   */
  async scanTag(
    user: AuthUser,
    stockCountId: string,
    request: ScanStockCountRequest,
  ): Promise<ScanResult> {
    const stockCount = await this.requireStockCount(this.prisma, stockCountId);
    assertRoleAtBranch(user, stockCount.warehouse.branchId, SCAN_ROLES);
    return this.prisma.$transaction(async (transaction) => {
      await this.lockSessionWhileOpen(transaction, stockCountId);
      return this.recordScan(transaction, stockCountId, request.tagCode, user.id);
    });
  }

  /** Giữ khoá chia sẻ trên phiên; phiên đã đóng thì `409 INVALID_STATE`. */
  private async lockSessionWhileOpen(
    transaction: Transaction,
    stockCountId: string,
  ): Promise<void> {
    const openSessions = await transaction.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "inventory"."StockCount"
      WHERE "id" = ${stockCountId}::uuid AND "status" = 'OPEN'
      FOR SHARE`;
    if (openSessions.length === 0) {
      throw invalidState('Phiên kiểm kê đã đóng');
    }
  }

  private async recordScan(
    transaction: Transaction,
    stockCountId: string,
    tagCode: string,
    scannedBy: string,
  ): Promise<ScanResult> {
    const { count } = await transaction.stockCountLine.updateMany({
      where: { stockCountId, tagCode, status: 'EXPECTED' },
      data: { status: 'SCANNED', scannedBy, scannedAt: new Date() },
    });
    if (count > 0) {
      return { tagCode, result: 'MATCHED' };
    }
    const existingLine = await transaction.stockCountLine.count({
      where: { stockCountId, tagCode },
    });
    if (existingLine > 0) {
      return { tagCode, result: 'ALREADY_SCANNED' };
    }
    await transaction.stockCountExtra.createMany({
      data: [{ stockCountId, tagCode, scannedBy }],
      skipDuplicates: true,
    });
    return { tagCode, result: 'EXTRA' };
  }

  // ================================================================ đóng phiên
  /**
   * Đóng phiên trong MỘT transaction. Chiếc dự kiến mà không quét được và còn `IN_STOCK` → `MISSING` kèm sổ
   * kho `COUNT_MISSING`; chiếc đã bán hoặc đang giữ trong lúc kiểm kê → `MOVED` (không tính thiếu).
   *
   * Đồng thời:
   * - Hai người đóng cùng lúc: bước đầu là UPDATE có điều kiện `status = OPEN`, chỉ một bên đổi được, bên kia
   *   thấy 0 dòng và nhận `409 INVALID_STATE`.
   * - Đang quét dở: UPDATE đó cần khoá độc quyền nên chờ các lần quét (khoá chia sẻ) xong; quét sau đó nhận `409`.
   * - Chiếc có thể vừa được bán: khoá các chiếc chưa quét theo thứ tự `id` (cùng thứ tự với `deduct`, nên không
   *   khoá chéo nhau) rồi mới đọc trạng thái để quyết định thiếu hay không.
   */
  async closeStockCount(user: AuthUser, stockCountId: string): Promise<StockCountSummary> {
    const stockCount = await this.requireStockCount(this.prisma, stockCountId);
    assertRoleAtBranch(user, stockCount.warehouse.branchId, MANAGE_ROLES);
    await runWithLockRetry(() =>
      this.prisma.$transaction((transaction) =>
        this.closeInsideTransaction(transaction, user, stockCount),
      ),
    );
    return this.buildSummary(this.prisma, stockCountId);
  }

  private async closeInsideTransaction(
    transaction: Transaction,
    user: AuthUser,
    stockCount: { id: string; warehouseId: string },
  ): Promise<void> {
    await transaction.$executeRaw`SET LOCAL lock_timeout = '3s'`;
    await this.claimOpenSession(transaction, stockCount.id, user.id);
    const notScanned = await transaction.stockCountLine.findMany({
      where: { stockCountId: stockCount.id, status: 'EXPECTED' },
      orderBy: { jewelryItemId: 'asc' },
    });
    const itemsStillInStock = await this.lockItemsAndFindThoseInStock(
      transaction,
      notScanned.map((line) => line.jewelryItemId),
    );
    const missingLines = notScanned.filter((line) => itemsStillInStock.has(line.jewelryItemId));
    const movedLines = notScanned.filter((line) => !itemsStillInStock.has(line.jewelryItemId));

    await this.setLineStatus(transaction, missingLines, 'MISSING');
    await this.setLineStatus(transaction, movedLines, 'MOVED');
    await this.recordMissingMovements(transaction, stockCount, missingLines, user.id);
    await writeAudit(transaction, {
      actorId: user.id,
      action: 'stock_count.closed',
      entityType: 'StockCount',
      entityId: stockCount.id,
      data: { missing: missingLines.length, moved: movedLines.length },
    });
  }

  /** Giành quyền đóng phiên bằng UPDATE có điều kiện. 0 dòng nghĩa là phiên đã đóng. */
  private async claimOpenSession(transaction: Transaction, stockCountId: string, closedBy: string) {
    const { count } = await transaction.stockCount.updateMany({
      where: { id: stockCountId, status: 'OPEN' },
      data: { status: 'CLOSED', closedBy, closedAt: new Date(), version: { increment: 1 } },
    });
    if (count === 0) {
      throw invalidState('Phiên kiểm kê đã đóng');
    }
  }

  /** Khoá các chiếc theo thứ tự `id` và trả về tập `id` những chiếc còn `IN_STOCK`. */
  private async lockItemsAndFindThoseInStock(
    transaction: Transaction,
    itemIds: string[],
  ): Promise<Set<string>> {
    const lockedItems = await transaction.$queryRaw<{ id: string; status: string }[]>`
      SELECT "id", "status" FROM "inventory"."JewelryItem"
      WHERE "id" = ANY(${itemIds}::uuid[])
      ORDER BY "id"
      FOR UPDATE`;
    return new Set(lockedItems.filter((item) => item.status === 'IN_STOCK').map((item) => item.id));
  }

  private async setLineStatus(
    transaction: Transaction,
    lines: { id: string }[],
    status: 'MISSING' | 'MOVED',
  ): Promise<void> {
    if (lines.length === 0) {
      return;
    }
    await transaction.stockCountLine.updateMany({
      where: { id: { in: lines.map((line) => line.id) }, status: 'EXPECTED' },
      data: { status },
    });
  }

  /**
   * Ghi sổ kho `COUNT_MISSING` cho từng chiếc thiếu. Trạng thái chiếc KHÔNG đổi (vẫn `IN_STOCK`) nên `toStatus`
   * ghi đúng trạng thái đó. Unique của sổ kho và `skipDuplicates` giữ cho không ghi trùng.
   */
  private async recordMissingMovements(
    transaction: Transaction,
    stockCount: { id: string; warehouseId: string },
    missingLines: { jewelryItemId: string }[],
    closedBy: string,
  ): Promise<void> {
    await transaction.stockMovement.createMany({
      data: missingLines.map((line) => ({
        jewelryItemId: line.jewelryItemId,
        warehouseId: stockCount.warehouseId,
        type: 'COUNT_MISSING' as const,
        toStatus: 'IN_STOCK' as const,
        refType: STOCK_COUNT_REFERENCE,
        refId: stockCount.id,
        createdBy: closedBy,
      })),
      skipDuplicates: true,
    });
  }

  // ================================================================ xem
  /** Tổng số dự kiến, đã quét, thiếu, thừa của phiên. Chỉ đọc. */
  async getStockCount(user: AuthUser, stockCountId: string): Promise<StockCountSummary> {
    const stockCount = await this.requireStockCount(this.prisma, stockCountId);
    assertRoleAtBranch(user, stockCount.warehouse.branchId, SCAN_ROLES);
    return this.buildSummary(this.prisma, stockCountId);
  }

  private async buildSummary(
    database: Pick<Transaction, 'stockCount' | 'stockCountLine' | 'stockCountExtra'>,
    stockCountId: string,
  ): Promise<StockCountSummary> {
    const stockCount = await this.requireStockCount(database, stockCountId);
    const lineStatusCounts = await database.stockCountLine.groupBy({
      by: ['status'],
      where: { stockCountId },
      _count: { _all: true },
    });
    const countOf = (status: string) =>
      lineStatusCounts.find((entry) => entry.status === status)?._count._all ?? 0;
    const missingLines = await database.stockCountLine.findMany({
      where: { stockCountId, status: 'MISSING' },
      orderBy: { tagCode: 'asc' },
      select: { tagCode: true },
    });
    const extras = await database.stockCountExtra.findMany({
      where: { stockCountId },
      orderBy: { tagCode: 'asc' },
      select: { tagCode: true },
    });
    return {
      id: stockCount.id,
      code: stockCount.code,
      branchId: stockCount.warehouse.branchId,
      status: stockCount.status,
      createdBy: stockCount.createdBy,
      closedBy: stockCount.closedBy,
      closedAt: stockCount.closedAt?.toISOString() ?? null,
      version: stockCount.version,
      expectedCount: lineStatusCounts.reduce((total, entry) => total + entry._count._all, 0),
      scannedCount: countOf('SCANNED'),
      notScannedCount: countOf('EXPECTED'),
      missingCount: countOf('MISSING'),
      movedCount: countOf('MOVED'),
      extraCount: extras.length,
      missingTagCodes: missingLines.map((line) => line.tagCode),
      extraTagCodes: extras.map((extra) => extra.tagCode),
    };
  }

  private async requireStockCount(database: Pick<Transaction, 'stockCount'>, stockCountId: string) {
    const stockCount = await database.stockCount.findUnique({
      where: { id: stockCountId },
      include: { warehouse: { select: { branchId: true } } },
    });
    if (stockCount === null) {
      throw notFound('phiên kiểm kê');
    }
    return stockCount;
  }
}
