import { BusinessError, outbox, violatedUniqueIndex } from '@jewelry/common';
import {
  type Branch,
  type BranchPage,
  type CreateBranchRequest,
  type PaginationQuery,
  ROUTING_KEYS,
  type UpdateBranchRequest,
} from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import type { Branch as BranchRow, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAudit } from './audit';
import { assertAllowed, loadActor } from './policy';

const toBranch = ({ id, code, name, address, phone, isActive, version }: BranchRow): Branch => ({
  id,
  code,
  name,
  address,
  phone,
  isActive,
  version,
});

const notFound = () => new BusinessError('NOT_FOUND', 'Không tìm thấy chi nhánh', 404);

/** `branch.updated` mang `isActive`, nên inventory biết cả khi chi nhánh ngừng hoạt động. */
const addUpdatedEvent = (tx: Prisma.TransactionClient, branch: BranchRow) =>
  outbox.add(tx, {
    eventType: ROUTING_KEYS.BRANCH_UPDATED,
    aggregateType: 'Branch',
    aggregateId: branch.id,
    payload: {
      branchId: branch.id,
      code: branch.code,
      name: branch.name,
      isActive: branch.isActive,
    },
  });

@Injectable()
export class BranchesService {
  constructor(private readonly prisma: PrismaService) {}

  private async authorize(actorId: string): Promise<void> {
    assertAllowed(await loadActor(this.prisma, actorId), { kind: 'branch.manage' });
  }

  async list(actorId: string, { page, pageSize }: PaginationQuery): Promise<BranchPage> {
    await this.authorize(actorId);
    const [rows, total] = await Promise.all([
      this.prisma.branch.findMany({
        orderBy: { code: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.branch.count(),
    ]);
    return { items: rows.map(toBranch), total, page, pageSize };
  }

  /**
   * Tạo chi nhánh, sự kiện `branch.created` và nhật ký trong một transaction.
   * Đồng thời: hai request cùng `code` thì unique chặn một bên, bắt `P2002` đúng index đó.
   */
  async create(actorId: string, body: CreateBranchRequest): Promise<Branch> {
    await this.authorize(actorId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.branch.create({ data: body });
        await outbox.add(tx, {
          eventType: ROUTING_KEYS.BRANCH_CREATED,
          aggregateType: 'Branch',
          aggregateId: created.id,
          payload: { branchId: created.id, code: created.code, name: created.name },
        });
        const branch = toBranch(created);
        await writeAudit(tx, {
          actorId,
          action: 'branch.created',
          entityType: 'Branch',
          entityId: created.id,
          before: null,
          after: branch,
        });
        return branch;
      });
    } catch (error) {
      if (violatedUniqueIndex(error) === 'Branch_code_key') {
        throw new BusinessError('VALIDATION_FAILED', 'Dữ liệu không hợp lệ', 400, {
          fields: [{ field: 'code', message: 'Mã chi nhánh đã tồn tại' }],
        });
      }
      throw error;
    }
  }

  /** Khoá lạc quan: `updateMany` có điều kiện `version`, hai người cùng sửa thì người sau nhận `409`. */
  async update(
    actorId: string,
    branchId: string,
    { version, ...changes }: UpdateBranchRequest,
  ): Promise<Branch> {
    await this.authorize(actorId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.branch.findUnique({ where: { id: branchId } });
      if (before === null) {
        throw notFound();
      }
      const { count } = await tx.branch.updateMany({
        where: { id: branchId, version },
        data: { ...changes, version: { increment: 1 } },
      });
      if (count === 0) {
        throw new BusinessError('VERSION_CONFLICT', 'Dữ liệu đã bị người khác sửa', 409);
      }
      return this.finishChange(tx, actorId, 'branch.updated', before);
    });
  }

  /**
   * Ngừng hoạt động. Không xoá vai trò của nhân viên: `ACTIVE_ASSIGNMENTS` bỏ qua chi nhánh này khi phát token.
   * Đồng thời: UPDATE có điều kiện `isActive = true` nên hai lần gọi song song chỉ một lần phát sự kiện.
   */
  async deactivate(actorId: string, branchId: string): Promise<Branch> {
    await this.authorize(actorId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.branch.findUnique({ where: { id: branchId } });
      if (before === null) {
        throw notFound();
      }
      const { count } = await tx.branch.updateMany({
        where: { id: branchId, isActive: true },
        data: { isActive: false, version: { increment: 1 } },
      });
      if (count === 0) {
        throw new BusinessError('INVALID_STATE', 'Chi nhánh đã ngừng hoạt động', 409);
      }
      return this.finishChange(tx, actorId, 'branch.deactivated', before);
    });
  }

  /**
   * Mở lại chi nhánh đã ngừng. Vai trò của nhân viên vẫn còn trong `UserBranch` nên có hiệu lực trở lại ở lần
   * đăng nhập hoặc refresh kế tiếp. Đồng thời: UPDATE có điều kiện `isActive = false`, hai lần gọi song song
   * chỉ một lần phát sự kiện.
   */
  async activate(actorId: string, branchId: string): Promise<Branch> {
    await this.authorize(actorId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.branch.findUnique({ where: { id: branchId } });
      if (before === null) {
        throw notFound();
      }
      const { count } = await tx.branch.updateMany({
        where: { id: branchId, isActive: false },
        data: { isActive: true, version: { increment: 1 } },
      });
      if (count === 0) {
        throw new BusinessError('INVALID_STATE', 'Chi nhánh đang hoạt động', 409);
      }
      return this.finishChange(tx, actorId, 'branch.activated', before);
    });
  }

  private async finishChange(
    tx: Prisma.TransactionClient,
    actorId: string,
    action: string,
    before: BranchRow,
  ): Promise<Branch> {
    const after = await tx.branch.findUniqueOrThrow({ where: { id: before.id } });
    await addUpdatedEvent(tx, after);
    const branch = toBranch(after);
    await writeAudit(tx, {
      actorId,
      action,
      entityType: 'Branch',
      entityId: before.id,
      before: toBranch(before),
      after: branch,
    });
    return branch;
  }
}
