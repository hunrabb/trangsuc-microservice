import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  BusinessError,
  runWithLockRetry,
  violatedUniqueIndex,
  type AuthUser,
} from '@jewelry/common';
import type { BuybackDetail, BuybackQuery, CreateBuyback, UpdateBuyback } from '@jewelry/contracts';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertOrderBranch } from '../core/order-record';
import { normalizeCustomerPhone } from '../pos/pos-customers.service';

const detailInclude = {
  items: { orderBy: { position: 'asc' as const } },
  audit: { orderBy: { toVersion: 'desc' as const }, take: 50 },
} satisfies Prisma.BuybackIntakeInclude;
type Intake = Prisma.BuybackIntakeGetPayload<{ include: typeof detailInclude }>;
type Header = Prisma.BuybackIntakeGetPayload<object>;
type Tx = Prisma.TransactionClient;
const missing = () => new BusinessError('NOT_FOUND', 'Không tìm thấy phiếu thu mua', 404);
const invalidState = () =>
  new BusinessError('INVALID_STATE', 'Trạng thái phiếu không cho phép thao tác', 409);
const conflict = () =>
  new BusinessError('VERSION_CONFLICT', 'Phiếu đã thay đổi; tải lại trước khi thao tác', 409);

function summary(row: Header, itemCount: number) {
  return {
    id: row.id,
    code: row.code,
    branchId: row.branchId,
    createdBy: row.createdBy,
    customerId: row.customerId,
    customerName: row.customerName,
    status: row.status,
    version: row.version,
    receivedAt: row.receivedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    itemCount,
  };
}
function present(row: Intake): BuybackDetail {
  return {
    ...summary(row, row.items.length),
    customerPhone: row.customerPhone,
    notes: row.notes,
    cancellationReason: row.cancellationReason,
    items: row.items.map((item) => ({
      id: item.id,
      position: item.position,
      source: item.source,
      referenceTagCode: item.referenceTagCode,
      assetKind: item.assetKind,
      description: item.description,
      condition: item.condition,
      declaredWeight: item.declaredWeight?.toFixed(4) ?? null,
      initialMeasuredWeight: item.initialMeasuredWeight?.toFixed(4) ?? null,
      declaredPurity: item.declaredPurity,
      notes: item.notes,
    })),
    latestAudit: row.audit.map((audit) => ({
      id: audit.id,
      actorId: audit.actorId,
      branchId: audit.branchId,
      action: audit.action,
      fromStatus: audit.fromStatus,
      toStatus: audit.toStatus,
      fromVersion: audit.fromVersion,
      toVersion: audit.toVersion,
      createdAt: audit.createdAt.toISOString(),
    })),
  };
}
function normalize(request: CreateBuyback): CreateBuyback {
  return {
    customer:
      'customerId' in request.customer
        ? { customerId: request.customer.customerId }
        : {
            name: request.customer.name.trim(),
            phone: normalizeCustomerPhone(request.customer.phone),
          },
    notes: request.notes,
    items: request.items.map((item) => ({
      source: item.source,
      referenceTagCode: item.referenceTagCode,
      assetKind: item.assetKind,
      description: item.description,
      condition: item.condition,
      declaredPurity: item.declaredPurity,
      notes: item.notes,
      declaredWeight:
        item.declaredWeight === null ? null : new Prisma.Decimal(item.declaredWeight).toFixed(4),
      initialMeasuredWeight:
        item.initialMeasuredWeight === null
          ? null
          : new Prisma.Decimal(item.initialMeasuredWeight).toFixed(4),
    })),
  };
}
function elevated(user: AuthUser, branchId: string): boolean {
  return user.branches.some(
    (a) =>
      (a.role === 'ADMIN' && a.branchId === null) ||
      (a.role === 'MANAGER' && a.branchId === branchId),
  );
}

/** Sales tiếp nhận thông tin; không định giá, không chuyển quyền sở hữu hay gọi Inventory. */
@Injectable()
export class BuybacksService {
  constructor(private readonly prisma: PrismaService) {}

  private write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runWithLockRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
          return work(tx);
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
  }

  private async customer(tx: Tx, request: CreateBuyback) {
    if (!('customerId' in request.customer)) {
      return {
        customerId: null,
        customerName: request.customer.name,
        customerPhone: request.customer.phone,
      };
    }
    const customer = await tx.customer.findUnique({
      where: { id: request.customer.customerId },
      select: { id: true, name: true, phone: true },
    });
    if (customer === null) throw new BusinessError('NOT_FOUND', 'Không tìm thấy khách hàng', 404);
    return {
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: normalizeCustomerPhone(customer.phone),
    };
  }

  private async read(tx: Tx, branchId: string, id: string): Promise<BuybackDetail> {
    const row = await tx.buybackIntake.findFirst({
      where: { id, branchId },
      include: detailInclude,
    });
    if (row === null) throw missing();
    return present(row);
  }

  private async replay(tx: Tx, branchId: string, createdBy: string, key: string, hash?: string) {
    const row = await tx.buybackIntake.findUnique({
      where: { branchId_createdBy_idempotencyKey: { branchId, createdBy, idempotencyKey: key } },
    });
    if (row === null) return null;
    if (hash !== undefined && row.requestHash !== hash) {
      throw new BusinessError('IDEMPOTENCY_KEY_REUSED', 'Key đã dùng cho nội dung khác', 422);
    }
    // Header + các dòng thay thế khi sửa DRAFT phải được đọc nhất quán.
    await tx.$queryRaw`SELECT "id" FROM "sales"."BuybackIntake" WHERE "id" = ${row.id}::uuid FOR SHARE`;
    return this.read(tx, branchId, row.id);
  }

  async create(
    user: AuthUser,
    branchId: string,
    key: string,
    input: CreateBuyback,
  ): Promise<BuybackDetail> {
    assertOrderBranch(user, branchId);
    const request = normalize(input);
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    try {
      return await this.write(async (tx) => {
        const existing = await this.replay(tx, branchId, user.id, key, hash);
        if (existing !== null) return existing;
        const customer = await this.customer(tx, request);
        const id = randomUUID();
        await tx.buybackIntake.create({
          data: {
            id,
            code: `BB-${randomUUID()}`,
            branchId,
            createdBy: user.id,
            idempotencyKey: key,
            requestHash: hash,
            ...customer,
            notes: request.notes,
            items: {
              create: request.items.map((item, index) => ({ ...item, position: index + 1 })),
            },
            audit: {
              create: {
                branchId,
                actorId: user.id,
                action: 'CREATED',
                toStatus: 'DRAFT',
                toVersion: 1,
              },
            },
          },
        });
        return this.read(tx, branchId, id);
      });
    } catch (error) {
      if (violatedUniqueIndex(error) !== 'BuybackIntake_branchId_createdBy_idempotencyKey_key')
        throw error;
      return this.write(async (tx) => {
        const existing = await this.replay(tx, branchId, user.id, key, hash);
        if (existing === null) throw error;
        return existing;
      });
    }
  }

  async byKey(user: AuthUser, branchId: string, key: string): Promise<BuybackDetail> {
    assertOrderBranch(user, branchId);
    return this.write(async (tx) => {
      const row = await this.replay(tx, branchId, user.id, key);
      if (row === null) throw missing();
      return row;
    });
  }

  async detail(user: AuthUser, branchId: string, id: string): Promise<BuybackDetail> {
    assertOrderBranch(user, branchId);
    return this.prisma.$transaction((tx) => this.read(tx, branchId, id), {
      isolationLevel: 'RepeatableRead',
    });
  }

  async list(user: AuthUser, branchId: string, query: BuybackQuery) {
    assertOrderBranch(user, branchId);
    const where: Prisma.BuybackIntakeWhereInput = {
      branchId,
      status: query.status,
      receivedAt: {
        gte: query.from ? new Date(query.from) : undefined,
        lte: query.to ? new Date(query.to) : undefined,
      },
    };
    return this.prisma.$transaction(
      async (tx) => {
        const total = await tx.buybackIntake.count({ where });
        const rows = await tx.buybackIntake.findMany({
          where,
          orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          include: { _count: { select: { items: true } } },
        });
        return {
          items: rows.map((row) => summary(row, row._count.items)),
          total,
          page: query.page,
          pageSize: query.pageSize,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private async mutate(
    user: AuthUser,
    branchId: string,
    id: string,
    version: number,
    action: 'UPDATED' | 'SUBMITTED' | 'CANCELLED',
    request?: CreateBuyback,
    reason?: string,
  ): Promise<BuybackDetail> {
    assertOrderBranch(user, branchId);
    return this.write(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "sales"."BuybackIntake" WHERE "id" = ${id}::uuid AND "branchId" = ${branchId}::uuid FOR UPDATE`;
      const row = await tx.buybackIntake.findFirst({ where: { id, branchId } });
      if (row === null) throw missing();
      const manager = elevated(user, branchId);
      if (!manager && row.createdBy !== user.id)
        throw new BusinessError('FORBIDDEN', 'STAFF chỉ sửa hoặc gửi phiếu do mình tiếp nhận', 403);
      if (row.version !== version) throw conflict();
      if (
        row.status !== 'DRAFT' &&
        !(action === 'CANCELLED' && manager && row.status === 'PENDING_APPRAISAL')
      )
        throw invalidState();
      const status =
        action === 'SUBMITTED'
          ? 'PENDING_APPRAISAL'
          : action === 'CANCELLED'
            ? 'CANCELLED'
            : 'DRAFT';
      const changed = await tx.buybackIntake.updateMany({
        where: { id, branchId, version, status: row.status },
        data: {
          version: { increment: 1 },
          status,
          ...(request ? { ...(await this.customer(tx, request)), notes: request.notes } : {}),
          ...(action === 'SUBMITTED' ? { submittedAt: new Date() } : {}),
          ...(action === 'CANCELLED'
            ? { cancelledAt: new Date(), cancellationReason: reason }
            : {}),
        },
      });
      if (changed.count !== 1) throw conflict();
      if (request) {
        await tx.buybackIntakeItem.deleteMany({ where: { intakeId: id } });
        await tx.buybackIntakeItem.createMany({
          data: request.items.map((item, index) => ({
            ...item,
            intakeId: id,
            position: index + 1,
          })),
        });
      }
      await tx.buybackIntakeAudit.create({
        data: {
          intakeId: id,
          actorId: user.id,
          branchId,
          action,
          fromStatus: row.status,
          toStatus: status,
          fromVersion: version,
          toVersion: version + 1,
        },
      });
      return this.read(tx, branchId, id);
    });
  }

  async update(user: AuthUser, branchId: string, id: string, request: UpdateBuyback) {
    assertOrderBranch(user, branchId);
    return this.mutate(user, branchId, id, request.version, 'UPDATED', normalize(request));
  }
  submit(user: AuthUser, branchId: string, id: string, version: number) {
    return this.mutate(user, branchId, id, version, 'SUBMITTED');
  }
  cancel(user: AuthUser, branchId: string, id: string, version: number, reason: string) {
    return this.mutate(user, branchId, id, version, 'CANCELLED', undefined, reason);
  }
}
