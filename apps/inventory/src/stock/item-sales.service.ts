import { BusinessError, outbox, runWithLockRetry } from '@jewelry/common';
import {
  type DeductedItem,
  type DeductStockRequest,
  type DeductStockResponse,
  type QuoteItem,
  type QuoteStockRequest,
  type QuoteStockResponse,
  type StockOrderStateResponse,
  ROUTING_KEYS,
} from '@jewelry/contracts';
import type { ReleaseStockResponse } from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { findCurrentPrice, priceNotSet } from '../catalog/metals.service';
import { invalidState } from '../common/errors';
import { computeItemPrice } from '../pricing/pricing';

type Transaction = Prisma.TransactionClient;
type Money = Prisma.Decimal;

const WITH_BRANCH_AND_METAL = {
  warehouse: { select: { branchId: true } },
  variant: { select: { metalId: true, product: { select: { name: true } } } },
} as const satisfies Prisma.JewelryItemInclude;

type ItemRow = Prisma.JewelryItemGetPayload<{ include: typeof WITH_BRANCH_AND_METAL }>;

/** Một đơn đang xử lý nằm ở trạng thái nào so với các chiếc được yêu cầu. */
type OrderProgress = 'ORDER_IS_NEW' | 'ORDER_ALREADY_DEDUCTED';

/** `orderId` của movement: kho do đơn bán nào thay đổi. */
const ORDER_REFERENCE = 'Order';

const itemNotAvailable = (tagCodes: string[]) =>
  new BusinessError('ITEM_NOT_AVAILABLE', 'Có món hàng không còn bán được', 409, {
    tagCodes: [...tagCodes].sort(),
  });

const idempotencyReused = () =>
  new BusinessError(
    'IDEMPOTENCY_KEY_REUSED',
    'orderId này đã được dùng cho một yêu cầu khác nội dung',
    422,
  );

/**
 * API nội bộ cho sales (luồng POS): báo giá (`quoteItems`), trừ kho khi bán (`deductItemsForOrder`) và trả hàng
 * về kho (`releaseItemsForOrder`). Chống bán trùng MỘT tem là việc quan trọng nhất của file này.
 *
 * Nguyên tắc chung cho mọi thay đổi kho:
 * - Khoá `StockOrderOperation` theo `orderId` trước, rồi khoá các chiếc theo thứ tự `id` trước khi đọc hay sửa.
 *   Hai đơn tranh cùng một nhóm tem luôn khoá chiếc theo cùng thứ tự; đơn đến sau chờ rồi thấy trạng thái mới.
 * - Mỗi lần đổi trạng thái là UPDATE có điều kiện (`WHERE id = ? AND status = ?`), kiểm tra số dòng bị ảnh hưởng.
 * - Sổ kho (`StockMovement`) có unique (refType, refId, jewelryItemId, type): lặp lại, kể cả song song, không ghi trùng.
 * - Trong transaction không gọi HTTP hay RabbitMQ: sự kiện chỉ ghi vào outbox.
 */
@Injectable()
export class ItemSalesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Đọc một snapshot nhất quán để Sales biết deduct đã commit hay release đã chặn đơn. */
  getOrderState(orderId: string): Promise<StockOrderStateResponse> {
    return this.prisma.$transaction(
      async (transaction) => {
        const operation = await transaction.stockOrderOperation.findUnique({ where: { orderId } });
        const soldItems = await transaction.jewelryItem.findMany({
          where: { orderId, status: 'SOLD' },
          select: { tagCode: true, warehouse: { select: { branchId: true } } },
        });
        return {
          orderId,
          released: operation?.releasedAt !== null && operation?.releasedAt !== undefined,
          soldItems: soldItems.map((item) => ({
            tagCode: item.tagCode,
            branchId: item.warehouse.branchId,
          })),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  // ================================================================ quote
  /**
   * Báo giá các chiếc theo mã tem: còn bán không, trọng lượng, tiền công, giá kim loại hiện tại và giá.
   * Chỉ đọc, không khoá: kết quả có thể cũ ngay sau đó, nên người gọi phải gọi `deduct` để thật sự giữ hàng.
   */
  async quoteItems({ tagCodes, branchId }: QuoteStockRequest): Promise<QuoteStockResponse> {
    const rows = await this.prisma.jewelryItem.findMany({
      where: { tagCode: { in: tagCodes } },
      include: WITH_BRANCH_AND_METAL,
    });
    const rowByTag = new Map(rows.map((row) => [row.tagCode, row]));
    const sellPriceByMetal = await this.loadSellPrices(this.prisma, rows);

    const items = tagCodes.map((tagCode) =>
      this.quoteOneItem(tagCode, rowByTag.get(tagCode), branchId, sellPriceByMetal),
    );
    return { items };
  }

  private quoteOneItem(
    tagCode: string,
    row: ItemRow | undefined,
    requestedBranchId: string | undefined,
    sellPriceByMetal: Map<string, Money>,
  ): QuoteItem {
    const unavailable = (reason: 'NOT_FOUND' | 'WRONG_BRANCH' | 'NOT_IN_STOCK'): QuoteItem => ({
      tagCode,
      available: false,
      reason,
      weight: null,
      laborFee: null,
      metalSellPricePerChi: null,
      price: null,
    });
    if (row === undefined) {
      return unavailable('NOT_FOUND');
    }
    if (requestedBranchId !== undefined && row.warehouse.branchId !== requestedBranchId) {
      return unavailable('WRONG_BRANCH');
    }
    if (row.status !== 'IN_STOCK') {
      return unavailable('NOT_IN_STOCK');
    }
    const sellPrice = sellPriceByMetal.get(row.variant.metalId);
    return {
      tagCode,
      available: true,
      reason: null,
      weight: row.weight.toFixed(4),
      laborFee: row.laborFee.toFixed(2),
      metalSellPricePerChi: sellPrice?.toFixed(2) ?? null,
      price:
        sellPrice === undefined
          ? null
          : computeItemPrice(row.weight, sellPrice, row.laborFee).toFixed(2),
    };
  }

  // ================================================================ deduct
  /**
   * Trừ kho khi bán: các chiếc `IN_STOCK` của chi nhánh chuyển sang `SOLD` cho đơn `orderId`. TẤT CẢ HOẶC KHÔNG
   * CÓ GÌ: một chiếc không bán được thì hoàn tác cả đơn và trả `409 ITEM_NOT_AVAILABLE` kèm mã tem.
   *
   * Đồng thời:
   * - Hai đơn cùng mua một tem: chiếc đó bị khoá, đơn đến sau chờ đơn trước xong rồi thấy `SOLD` → `409`. Đúng
   *   một đơn thành công.
   * - Cùng `orderId` gọi lại (mạng chập chờn, POS gọi lại), kể cả hai lần SONG SONG: lần sau thấy các chiếc đã
   *   `SOLD` cho chính `orderId` đó, trả lại kết quả cũ (`replayed = true`), không trừ kho lần nữa.
   * - Release đến trước commit deduct: hai bên chờ cùng khoá orderId; sau release, deduct muộn bị chặn.
   * - Deadlock còn sót lại: `runWithLockRetry` chạy lại cả transaction tối đa 3 lần.
   */
  async deductItemsForOrder(request: DeductStockRequest): Promise<DeductStockResponse> {
    return runWithLockRetry(() =>
      this.prisma.$transaction((transaction) => this.deductInsideTransaction(transaction, request)),
    );
  }

  private async deductInsideTransaction(
    transaction: Transaction,
    request: DeductStockRequest,
  ): Promise<DeductStockResponse> {
    await transaction.$executeRaw`SET LOCAL lock_timeout = '3s'`;
    const operation = await this.lockOrderOperation(transaction, request.orderId, false);
    if (operation.releasedAt !== null) {
      throw invalidState('Đơn này đã được giải phóng hàng, hãy dùng orderId mới');
    }
    const lockedRows = await this.lockAndLoadItemsByTag(transaction, request.tagCodes);

    this.assertEveryTagExistsInBranch(lockedRows, request);
    const progress = await this.checkOrderProgress(transaction, lockedRows, request);

    if (progress === 'ORDER_ALREADY_DEDUCTED') {
      return this.buildStoredResult(lockedRows, request);
    }
    await this.assertOrderWasNotReleasedBefore(transaction, request.orderId);
    return this.reserveItems(transaction, lockedRows, request);
  }

  /**
   * Phần đã chắc chắn bán được: ghi giá chốt và đổi trạng thái từng chiếc, ghi sổ kho, ghi sự kiện outbox.
   * Giá kim loại hiện tại được lấy một lần ở đây và lưu vào từng chiếc, để lần gọi lặp trả đúng giá này.
   */
  private async reserveItems(
    transaction: Transaction,
    lockedRows: ItemRow[],
    request: DeductStockRequest,
  ): Promise<DeductStockResponse> {
    const sellPriceByMetal = await this.loadSellPrices(transaction, lockedRows);
    const soldItems: DeductedItem[] = [];

    for (const row of lockedRows) {
      const metalSellPrice = this.requireSellPrice(sellPriceByMetal, row);
      const price = computeItemPrice(row.weight, metalSellPrice, row.laborFee);
      await this.markItemAsSold(transaction, row, request.orderId, metalSellPrice, price);
      soldItems.push(this.toDeductedItem(row, metalSellPrice, price));
    }
    await this.recordMovements(transaction, lockedRows, request.orderId, 'SALE', 'SOLD');
    await this.queueStockChangedEvent(
      transaction,
      request.orderId,
      request.branchId,
      'SOLD',
      lockedRows,
    );
    return {
      orderId: request.orderId,
      branchId: request.branchId,
      replayed: false,
      items: this.sortByTagCode(soldItems),
    };
  }

  /** Đổi một chiếc sang `SOLD` bằng UPDATE có điều kiện: 0 dòng nghĩa là trạng thái đã đổi ngoài dự kiến. */
  private async markItemAsSold(
    transaction: Transaction,
    row: ItemRow,
    orderId: string,
    metalSellPrice: Money,
    price: Money,
  ): Promise<void> {
    const { count } = await transaction.jewelryItem.updateMany({
      where: { id: row.id, status: 'IN_STOCK' },
      data: {
        status: 'SOLD',
        orderId,
        soldAt: new Date(),
        metalPriceAtSale: metalSellPrice,
        priceAtSale: price,
        version: { increment: 1 },
      },
    });
    if (count === 0) {
      throw itemNotAvailable([row.tagCode]);
    }
  }

  /** Mã tem không có, hoặc thuộc kho chi nhánh khác: coi như không bán được (không lộ kho khác có gì). */
  private assertEveryTagExistsInBranch(rows: ItemRow[], request: DeductStockRequest): void {
    const foundTags = new Set(
      rows.filter((row) => row.warehouse.branchId === request.branchId).map((row) => row.tagCode),
    );
    const missingTags = request.tagCodes.filter((tagCode) => !foundTags.has(tagCode));
    if (missingTags.length > 0) {
      throw itemNotAvailable(missingTags);
    }
  }

  /**
   * Quyết định dựa trên các dòng ĐÃ KHOÁ (nên là trạng thái mới nhất, kể cả sau khi chờ một đơn khác):
   * - mọi chiếc đều đã `SOLD` cho chính đơn này → đây là lần gọi lặp;
   * - một phần đã thuộc đơn này, hoặc đơn này đang giữ chiếc khác → cùng `orderId` nhưng khác nội dung → `422`;
   * - có chiếc không còn `IN_STOCK` → `409` kèm các mã tem đó;
   * - còn lại: đơn mới.
   */
  private async checkOrderProgress(
    transaction: Transaction,
    rows: ItemRow[],
    request: DeductStockRequest,
  ): Promise<OrderProgress> {
    const ownedByThisOrder = rows.filter(
      (row) => row.status === 'SOLD' && row.orderId === request.orderId,
    );
    const holdsOtherItems = await this.orderHoldsItemsOutsideRequest(transaction, request);

    if (ownedByThisOrder.length === rows.length && !holdsOtherItems) {
      return 'ORDER_ALREADY_DEDUCTED';
    }
    if (ownedByThisOrder.length > 0 || holdsOtherItems) {
      throw idempotencyReused();
    }
    const notInStock = rows.filter((row) => row.status !== 'IN_STOCK').map((row) => row.tagCode);
    if (notInStock.length > 0) {
      throw itemNotAvailable(notInStock);
    }
    return 'ORDER_IS_NEW';
  }

  private async orderHoldsItemsOutsideRequest(
    transaction: Transaction,
    request: DeductStockRequest,
  ): Promise<boolean> {
    const otherItems = await transaction.jewelryItem.count({
      where: { orderId: request.orderId, tagCode: { notIn: request.tagCodes } },
    });
    return otherItems > 0;
  }

  /**
   * Đơn đã `release` rồi thì `orderId` đó coi như đã dùng xong: cho trừ kho lại sẽ đụng unique của sổ kho (đã có
   * dòng SALE cũ) và sổ kho sẽ thiếu một dòng. Người gọi phải dùng `orderId` mới.
   */
  private async assertOrderWasNotReleasedBefore(
    transaction: Transaction,
    orderId: string,
  ): Promise<void> {
    const releases = await transaction.stockMovement.count({
      where: { refType: ORDER_REFERENCE, refId: orderId, type: 'RELEASE' },
    });
    if (releases > 0) {
      throw invalidState('Đơn này đã được giải phóng hàng, hãy dùng orderId mới');
    }
  }

  /** Kết quả của lần trừ kho đầu, dựng lại từ giá đã chốt trên từng chiếc. */
  private buildStoredResult(rows: ItemRow[], request: DeductStockRequest): DeductStockResponse {
    const items = rows.map((row) => {
      if (row.metalPriceAtSale === null || row.priceAtSale === null) {
        throw invalidState('Chiếc đã bán nhưng thiếu giá chốt');
      }
      return this.toDeductedItem(row, row.metalPriceAtSale, row.priceAtSale);
    });
    return {
      orderId: request.orderId,
      branchId: request.branchId,
      replayed: true,
      items: this.sortByTagCode(items),
    };
  }

  // ================================================================ release
  /**
   * Trả hàng về kho khi đơn thất bại hoặc bị huỷ: các chiếc `SOLD` của `orderId` về `IN_STOCK` (xoá đơn và giá
   * chốt khỏi chiếc đó), ghi sổ kho. Gọi lại không sao: đơn không còn chiếc nào đang giữ thì không làm gì và
   * không phát sự kiện. Khoá orderId trước, rồi khoá chiếc theo `id` như deduct để hai bên không khoá chéo nhau.
   */
  async releaseItemsForOrder(orderId: string): Promise<ReleaseStockResponse> {
    return runWithLockRetry(() =>
      this.prisma.$transaction((transaction) =>
        this.releaseInsideTransaction(transaction, orderId),
      ),
    );
  }

  private async releaseInsideTransaction(
    transaction: Transaction,
    orderId: string,
  ): Promise<ReleaseStockResponse> {
    await transaction.$executeRaw`SET LOCAL lock_timeout = '3s'`;
    await this.lockOrderOperation(transaction, orderId, true);
    const lockedRows = await this.lockAndLoadItemsByOrder(transaction, orderId);
    const soldRows = lockedRows.filter((row) => row.status === 'SOLD');
    if (soldRows.length === 0) {
      await this.markOrderReleased(transaction, orderId);
      return { orderId, releasedTagCodes: [] };
    }

    for (const row of soldRows) {
      await this.markItemAsInStock(transaction, row, orderId);
    }
    await this.recordMovements(transaction, soldRows, orderId, 'RELEASE', 'IN_STOCK');
    const branchId = soldRows[0]?.warehouse.branchId ?? '';
    await this.queueStockChangedEvent(transaction, orderId, branchId, 'RELEASED', soldRows);
    await this.markOrderReleased(transaction, orderId);
    return { orderId, releasedTagCodes: soldRows.map((row) => row.tagCode).sort() };
  }

  /** Khoá riêng theo orderId trước các chiếc hàng; release đến sớm vẫn có dòng để chặn deduct muộn. */
  private async lockOrderOperation(
    transaction: Transaction,
    orderId: string,
    releasedOnCreate: boolean,
  ): Promise<{ releasedAt: Date | null }> {
    const releasedAt = releasedOnCreate ? new Date() : null;
    await transaction.$executeRaw`
      INSERT INTO "inventory"."StockOrderOperation" ("orderId", "releasedAt")
      VALUES (${orderId}::uuid, ${releasedAt})
      ON CONFLICT ("orderId") DO NOTHING`;
    const [operation] = await transaction.$queryRaw<{ releasedAt: Date | null }[]>`
      SELECT "releasedAt" FROM "inventory"."StockOrderOperation"
      WHERE "orderId" = ${orderId}::uuid FOR UPDATE`;
    if (operation === undefined) throw invalidState('Không khoá được đơn trong kho');
    return operation;
  }

  /** Dấu release được commit cùng việc trả hàng; gọi lại hoặc restart không mở lại orderId này. */
  private async markOrderReleased(transaction: Transaction, orderId: string): Promise<void> {
    await transaction.stockOrderOperation.updateMany({
      where: { orderId, releasedAt: null },
      data: { releasedAt: new Date() },
    });
  }

  private async markItemAsInStock(
    transaction: Transaction,
    row: ItemRow,
    orderId: string,
  ): Promise<void> {
    const { count } = await transaction.jewelryItem.updateMany({
      where: { id: row.id, status: 'SOLD', orderId },
      data: {
        status: 'IN_STOCK',
        orderId: null,
        soldAt: null,
        metalPriceAtSale: null,
        priceAtSale: null,
        version: { increment: 1 },
      },
    });
    if (count === 0) {
      throw invalidState('Trạng thái chiếc hàng đã đổi trong lúc giải phóng');
    }
  }

  // ================================================================ dùng chung
  /**
   * Khoá các chiếc theo mã tem, SẮP THEO id. Thứ tự cố định này là điều kiện để hai đơn tranh cùng nhóm tem
   * không khoá vòng tròn. Trả các dòng đã khoá (đọc SAU khi giành được khoá nên là trạng thái mới nhất).
   */
  private async lockAndLoadItemsByTag(
    transaction: Transaction,
    tagCodes: string[],
  ): Promise<ItemRow[]> {
    const lockedIds = await transaction.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "inventory"."JewelryItem"
      WHERE "tagCode" = ANY(${tagCodes}::text[])
      ORDER BY "id"
      FOR UPDATE`;
    return this.loadItemsInOrder(
      transaction,
      lockedIds.map((row) => row.id),
    );
  }

  private async lockAndLoadItemsByOrder(
    transaction: Transaction,
    orderId: string,
  ): Promise<ItemRow[]> {
    const lockedIds = await transaction.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "inventory"."JewelryItem"
      WHERE "orderId" = ${orderId}::uuid
      ORDER BY "id"
      FOR UPDATE`;
    return this.loadItemsInOrder(
      transaction,
      lockedIds.map((row) => row.id),
    );
  }

  private async loadItemsInOrder(transaction: Transaction, itemIds: string[]): Promise<ItemRow[]> {
    const rows = await transaction.jewelryItem.findMany({
      where: { id: { in: itemIds } },
      include: WITH_BRANCH_AND_METAL,
      orderBy: { id: 'asc' },
    });
    return rows;
  }

  /** Ghi sổ kho. `skipDuplicates` + unique làm trọng tài: gọi lặp không thêm dòng thứ hai. */
  private async recordMovements(
    transaction: Transaction,
    rows: ItemRow[],
    orderId: string,
    type: 'SALE' | 'RELEASE',
    toStatus: 'SOLD' | 'IN_STOCK',
  ): Promise<void> {
    await transaction.stockMovement.createMany({
      data: rows.map((row) => ({
        jewelryItemId: row.id,
        warehouseId: row.warehouseId,
        type,
        toStatus,
        refType: ORDER_REFERENCE,
        refId: orderId,
        createdBy: null,
      })),
      skipDuplicates: true,
    });
  }

  /** Báo cho các service khác (report) qua outbox, cùng transaction. Mỗi lần xử lý một đơn chỉ phát một sự kiện. */
  private async queueStockChangedEvent(
    transaction: Transaction,
    orderId: string,
    branchId: string,
    reason: 'SOLD' | 'RELEASED',
    rows: ItemRow[],
  ): Promise<void> {
    await outbox.add(transaction, {
      eventType: ROUTING_KEYS.STOCK_CHANGED,
      aggregateType: 'Order',
      aggregateId: orderId,
      payload: { orderId, branchId, reason, tagCodes: rows.map((row) => row.tagCode).sort() },
    });
  }

  /** Giá bán ra hiện tại của từng kim loại có trong các chiếc này (mỗi kim loại tra một lần). */
  private async loadSellPrices(
    database: Pick<Transaction, '$queryRaw'>,
    rows: ItemRow[],
  ): Promise<Map<string, Money>> {
    const sellPriceByMetal = new Map<string, Money>();
    for (const metalId of new Set(rows.map((row) => row.variant.metalId))) {
      const currentPrice = await findCurrentPrice(database, metalId);
      if (currentPrice !== undefined) {
        sellPriceByMetal.set(metalId, currentPrice.sellPrice);
      }
    }
    return sellPriceByMetal;
  }

  private requireSellPrice(sellPriceByMetal: Map<string, Money>, row: ItemRow): Money {
    const sellPrice = sellPriceByMetal.get(row.variant.metalId);
    if (sellPrice === undefined) {
      throw priceNotSet();
    }
    return sellPrice;
  }

  private toDeductedItem(row: ItemRow, metalSellPrice: Money, price: Money): DeductedItem {
    return {
      itemId: row.id,
      tagCode: row.tagCode,
      // Sales chép tên lúc tạo hoá đơn; không phải đọc chéo schema hay tin tên từ client.
      productName: row.variant.product.name,
      weight: row.weight.toFixed(4),
      laborFee: row.laborFee.toFixed(2),
      metalSellPricePerChi: metalSellPrice.toFixed(2),
      price: price.toFixed(2),
      costPrice: row.costPrice.toFixed(2),
      variantId: row.variantId,
      metalId: row.variant.metalId,
    };
  }

  private sortByTagCode(items: DeductedItem[]): DeductedItem[] {
    return [...items].sort((first, second) => first.tagCode.localeCompare(second.tagCode));
  }
}
