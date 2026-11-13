import { randomBytes, randomUUID } from 'node:crypto';
import {
  type AuthUser,
  BusinessError,
  runWithLockRetry,
  violatedUniqueIndex,
} from '@jewelry/common';
import type {
  AddReceiptLineRequest,
  ApproveReceiptRequest,
  CreateReceiptRequest,
  ListReceiptsQuery,
  Receipt,
  ReceiptPage,
} from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAudit } from '../common/audit';
import { isSystemAdmin } from '../common/branch-access';
import { fieldError, invalidState, notFound, pageArgs, versionConflict } from '../common/errors';

const WITH_LINES = {
  warehouse: { select: { branchId: true } },
  lines: { orderBy: { tagCode: 'asc' } },
} as const satisfies Prisma.GoodsReceiptInclude;

type ReceiptRow = Prisma.GoodsReceiptGetPayload<{ include: typeof WITH_LINES }>;

const toReceipt = (row: ReceiptRow): Receipt => ({
  id: row.id,
  code: row.code,
  branchId: row.warehouse.branchId,
  status: row.status,
  note: row.note,
  createdBy: row.createdBy,
  approvedBy: row.approvedBy,
  approvedAt: row.approvedAt?.toISOString() ?? null,
  version: row.version,
  lines: row.lines.map((line) => ({
    id: line.id,
    variantId: line.variantId,
    tagCode: line.tagCode,
    weight: line.weight.toFixed(4),
    laborFee: line.laborFee.toFixed(2),
    costPrice: line.costPrice.toFixed(2),
  })),
});

const newReceiptCode = (): string => {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `PN-${day}-${randomBytes(4).toString('hex').toUpperCase()}`;
};

@Injectable()
export class ReceiptsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Tạo phiếu nháp cho kho của chi nhánh. Chi nhánh chưa có kho (chưa nhận `branch.created`) → `404`. */
  async create(user: AuthUser, body: CreateReceiptRequest): Promise<Receipt> {
    this.assertAdmin(user);
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { branchId: body.branchId },
    });
    if (warehouse === null) {
      throw notFound('kho của chi nhánh này');
    }
    if (!warehouse.isActive) {
      throw invalidState('Kho đã ngừng hoạt động');
    }
    const created = await this.prisma.goodsReceipt.create({
      data: {
        code: newReceiptCode(),
        warehouseId: warehouse.id,
        note: body.note,
        createdBy: user.id,
      },
      include: WITH_LINES,
    });
    return toReceipt(created);
  }

  async get(user: AuthUser, receiptId: string): Promise<Receipt> {
    this.assertAdmin(user);
    const row = await this.load(this.prisma, receiptId);

    return toReceipt(row);
  }

  async list(
    user: AuthUser,
    { branchId, status, ...paging }: ListReceiptsQuery,
  ): Promise<ReceiptPage> {
    this.assertAdmin(user);
    const where: Prisma.GoodsReceiptWhereInput = {
      ...(branchId === undefined ? {} : { warehouse: { branchId } }),
      ...(status === undefined ? {} : { status }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.goodsReceipt.findMany({
        where,
        include: WITH_LINES,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(paging),
      }),
      this.prisma.goodsReceipt.count({ where }),
    ]);
    return { items: rows.map(toReceipt), total, ...paging };
  }

  /**
   * Thêm một chiếc vào phiếu nháp. Mỗi lần thêm hoặc xoá dòng tăng `version` của phiếu bằng UPDATE có điều kiện
   * `status = DRAFT`: (1) người duyệt đã xem phiếu ở `version` cũ sẽ nhận `409` thay vì duyệt nhầm nội dung mới;
   * (2) UPDATE khoá dòng phiếu, nên không thể chen vào giữa lúc phiếu đang được duyệt.
   */
  async addLine(user: AuthUser, receiptId: string, body: AddReceiptLineRequest): Promise<Receipt> {
    await this.assertCanEditDraft(user, receiptId);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.bumpDraftVersion(tx, receiptId);
        const variant = await tx.productVariant.findUnique({ where: { id: body.variantId } });
        if (variant === null || !variant.isActive) {
          throw fieldError({
            field: 'variantId',
            message: 'Biến thể không tồn tại hoặc đã ngừng dùng',
          });
        }
        await tx.goodsReceiptLine.create({
          data: {
            receiptId,
            variantId: body.variantId,
            tagCode: body.tagCode,
            weight: body.weight,
            laborFee: body.laborFee ?? variant.defaultLaborFee,
            costPrice: body.costPrice,
          },
        });
      });
    } catch (error) {
      if (violatedUniqueIndex(error) === 'GoodsReceiptLine_receiptId_tagCode_key') {
        throw fieldError({ field: 'tagCode', message: 'Mã tem đã có trong phiếu này' });
      }
      throw error;
    }
    return toReceipt(await this.load(this.prisma, receiptId));
  }

  async removeLine(user: AuthUser, receiptId: string, lineId: string): Promise<Receipt> {
    await this.assertCanEditDraft(user, receiptId);
    await this.prisma.$transaction(async (tx) => {
      await this.bumpDraftVersion(tx, receiptId);
      const { count } = await tx.goodsReceiptLine.deleteMany({ where: { id: lineId, receiptId } });
      if (count === 0) {
        throw notFound('dòng của phiếu'); // ném trong transaction: `version` vừa tăng cũng được hoàn tác
      }
    });
    return toReceipt(await this.load(this.prisma, receiptId));
  }

  /**
   * DUYỆT phiếu, trong MỘT transaction: đổi phiếu sang `APPROVED`, tạo từng `JewelryItem` `IN_STOCK`, ghi
   * `StockMovement` và `AuditLog`. Lỗi ở bước nào thì cả transaction hoàn tác, phiếu vẫn là nháp.
   *
   * Đồng thời (hai người duyệt cùng một phiếu):
   * - Bước đầu là UPDATE có điều kiện `id`, `version`, `status = DRAFT`. Postgres khoá dòng phiếu: người đến
   *   trước đổi được, người đến sau chờ rồi thấy 0 dòng, nên CHỈ MỘT bên tạo hàng.
   * - 0 dòng: đọc lại để báo đúng lý do. Đã `APPROVED` → `409 INVALID_STATE`; còn nháp nhưng `version` lệch
   *   (có người thêm hoặc bớt dòng sau khi bạn xem) → `409 VERSION_CONFLICT`.
   * - Mã tem trùng với hàng đã có (unique `tagCode`) → hoàn tác, `400` kèm danh sách mã trùng.
   * - Deadlock giữa hai phiếu cùng mã tem: `runWithLockRetry` chạy lại tối đa 3 lần.
   */
  async approve(
    user: AuthUser,
    receiptId: string,
    { version }: ApproveReceiptRequest,
  ): Promise<Receipt> {
    this.assertAdmin(user);

    try {
      await runWithLockRetry(() =>
        this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
          const claimed = await tx.goodsReceipt.updateMany({
            where: { id: receiptId, version, status: 'DRAFT' },
            data: {
              status: 'APPROVED',
              approvedBy: user.id,
              approvedAt: new Date(),
              version: { increment: 1 },
            },
          });
          if (claimed.count === 0) {
            const now = await tx.goodsReceipt.findUnique({ where: { id: receiptId } });
            throw now === null
              ? notFound('phiếu nhập')
              : now.status === 'APPROVED'
                ? invalidState('Phiếu đã được duyệt')
                : versionConflict();
          }
          await this.createStock(tx, user, receiptId);
        }),
      );
    } catch (error) {
      if (violatedUniqueIndex(error) === 'JewelryItem_tagCode_key') {
        throw await this.duplicateTags(receiptId);
      }
      throw error;
    }
    return toReceipt(await this.load(this.prisma, receiptId));
  }

  /** Phần chạy SAU khi đã giành được phiếu: tạo hàng, ghi chuyển động kho và nhật ký. */
  private async createStock(tx: Prisma.TransactionClient, user: AuthUser, receiptId: string) {
    const receipt = await tx.goodsReceipt.findUniqueOrThrow({
      where: { id: receiptId },
      include: {
        warehouse: true,
        lines: { include: { variant: true }, orderBy: { tagCode: 'asc' } },
      },
    });
    if (receipt.lines.length === 0) {
      throw fieldError({ field: 'lines', message: 'Phiếu chưa có dòng nào' });
    }
    if (!receipt.warehouse.isActive) {
      throw invalidState('Kho đã ngừng hoạt động');
    }
    if (receipt.lines.some((line) => !line.variant.isActive)) {
      throw fieldError({ field: 'lines', message: 'Phiếu có biến thể đã ngừng dùng' });
    }
    const items = receipt.lines.map((line) => ({
      id: randomUUID(),
      tagCode: line.tagCode,
      variantId: line.variantId,
      warehouseId: receipt.warehouseId,
      weight: line.weight,
      laborFee: line.laborFee,
      costPrice: line.costPrice,
    }));
    await tx.jewelryItem.createMany({ data: items });
    await tx.stockMovement.createMany({
      data: items.map((item) => ({
        jewelryItemId: item.id,
        warehouseId: receipt.warehouseId,
        type: 'RECEIPT' as const,
        toStatus: 'IN_STOCK' as const,
        refType: 'GoodsReceipt',
        refId: receiptId,
        createdBy: user.id,
      })),
    });
    await writeAudit(tx, {
      actorId: user.id,
      action: 'goods_receipt.approved',
      entityType: 'GoodsReceipt',
      entityId: receiptId,
      data: { code: receipt.code, itemCount: items.length },
    });
  }

  /** Mã tem nào của phiếu đã tồn tại ở hàng khác, để báo cho người dùng sửa. */
  private async duplicateTags(receiptId: string): Promise<BusinessError> {
    const lines = await this.prisma.goodsReceiptLine.findMany({ where: { receiptId } });
    const existing = await this.prisma.jewelryItem.findMany({
      where: { tagCode: { in: lines.map((line) => line.tagCode) } },
      select: { tagCode: true },
    });
    const tags =
      existing.length === 0 ? ['(không xác định)'] : existing.map((item) => item.tagCode);
    return fieldError(
      ...tags.map((tag) => ({ field: 'tagCode', message: `Mã tem ${tag} đã tồn tại trong kho` })),
    );
  }

  private assertAdmin(user: AuthUser): void {
    if (!isSystemAdmin(user))
      throw new BusinessError('FORBIDDEN', 'Chỉ quản trị viên được quản lý nhập hàng', 403);
  }

  private async assertCanEditDraft(user: AuthUser, receiptId: string): Promise<void> {
    this.assertAdmin(user);
    const row = await this.load(this.prisma, receiptId);

    if (row.status !== 'DRAFT') {
      throw invalidState('Phiếu đã được duyệt, không sửa được');
    }
  }

  private async bumpDraftVersion(tx: Prisma.TransactionClient, receiptId: string): Promise<void> {
    const { count } = await tx.goodsReceipt.updateMany({
      where: { id: receiptId, status: 'DRAFT' },
      data: { version: { increment: 1 } },
    });
    if (count === 0) {
      throw invalidState('Phiếu đã được duyệt, không sửa được');
    }
  }

  private async load(db: Pick<Prisma.TransactionClient, 'goodsReceipt'>, receiptId: string) {
    const row = await db.goodsReceipt.findUnique({ where: { id: receiptId }, include: WITH_LINES });
    if (row === null) {
      throw notFound('phiếu nhập');
    }
    return row;
  }
}
