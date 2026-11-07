import { BusinessError, runWithLockRetry, violatedUniqueIndex } from '@jewelry/common';
import {
  type BranchRole,
  type CreateUserRequest,
  isAcceptablePassword,
  type ListUsersQuery,
  type ReplaceAssignmentsRequest,
  type ResetPasswordRequest,
  type UpdateUserRequest,
  type User,
  type UserPage,
} from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import { hash } from 'bcryptjs';
import type { Prisma } from '../generated/prisma/client';
import { BCRYPT_ROUNDS } from '../password/hashing';
import { PrismaService } from '../prisma/prisma.service';
import { writeAudit } from './audit';
import { assertAdminRemains, lockAdminsAndUser } from './last-admin';
import { type Actor, assertAllowed, loadActor, type UserActionKind } from './policy';

type Tx = Prisma.TransactionClient;

const USER_DETAIL = {
  branches: { select: { branchId: true, role: true }, orderBy: { createdAt: 'asc' } },
  identities: { select: { provider: true } },
} satisfies Prisma.UserInclude;

type UserRow = Prisma.UserGetPayload<{ include: typeof USER_DETAIL }>;

/** Dữ liệu trả cho client. Không có `passwordHash`. */
const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  fullName: row.fullName,
  phone: row.phone,
  status: row.status,
  googleLinked: row.identities.length > 0,
  branches: row.branches,
  version: row.version,
});

/** Ảnh chụp cho `AuditLog`: chỉ ghi có mật khẩu hay không, không bao giờ ghi hash. */
const toAuditSnapshot = (row: UserRow) => ({
  ...toUser(row),
  hasPassword: row.passwordHash !== null,
});

const hasAdminRole = (assignments: readonly BranchRole[]): boolean =>
  assignments.some(({ role }) => role === 'ADMIN');

const assignmentKey = ({ branchId, role }: BranchRole) => `${role}:${branchId}`;

/** Có vai trò cũ không còn trong danh sách mới, kể cả đổi STAFF thành MANAGER ở cùng chi nhánh. */
function losesAssignment(before: readonly BranchRole[], after: readonly BranchRole[]): boolean {
  const kept = new Set(after.map(assignmentKey));
  return before.some((assignment) => !kept.has(assignmentKey(assignment)));
}

const invalidField = (field: string, message: string) =>
  new BusinessError('VALIDATION_FAILED', 'Dữ liệu không hợp lệ', 400, {
    fields: [{ field, message }],
  });

const invalidState = (message: string) => new BusinessError('INVALID_STATE', message, 409);

/** bcrypt chậm nên luôn gọi ngoài transaction, sau khi đã kiểm quyền. */
async function hashNewPassword(password: string): Promise<string> {
  if (!isAcceptablePassword(password)) {
    throw new BusinessError(
      'PASSWORD_TOO_WEAK',
      'Mật khẩu phải có 12 ký tự trở lên và tối đa 72 byte',
      400,
    );
  }
  return hash(password, BCRYPT_ROUNDS);
}

/** Chỉ gán được vào chi nhánh tồn tại và đang hoạt động. */
async function assertBranchesUsable(tx: Tx, assignments: readonly BranchRole[]): Promise<void> {
  const ids = assignments.flatMap(({ branchId }) => (branchId === null ? [] : [branchId]));
  const usable = await tx.branch.count({ where: { id: { in: ids }, isActive: true } });
  if (usable !== ids.length) {
    throw invalidField('assignments', 'Chi nhánh không tồn tại hoặc đã ngừng hoạt động');
  }
}

/** Thu hồi mọi phiên cùng transaction với thay đổi. Access token đang dùng hết hiệu lực trong tối đa 15 phút. */
const revokeAllSessions = (tx: Tx, userId: string) =>
  tx.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

const bumpVersion = (tx: Tx, userId: string) =>
  tx.user.update({ where: { id: userId }, data: { version: { increment: 1 } } });

interface UserChange {
  kind: UserActionKind;
  auditAction: string;
  /** Thao tác có thể làm giảm số ADMIN đang hoạt động: chạy dưới quy tắc ADMIN cuối cùng. */
  canRemoveAdmin?: boolean;
  apply(tx: Tx, before: UserRow): Promise<void>;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actorId: string, { page, pageSize, branchId }: ListUsersQuery): Promise<UserPage> {
    assertAllowed(await loadActor(this.prisma, actorId), { kind: 'user.list', branchId });
    const where = branchId === undefined ? {} : { branches: { some: { branchId } } };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: USER_DETAIL,
        orderBy: { email: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items: rows.map(toUser), total, page, pageSize };
  }

  async get(actorId: string, userId: string): Promise<User> {
    const actor = await loadActor(this.prisma, actorId);
    const row = await this.loadUser(this.prisma, userId);
    assertAllowed(actor, { kind: 'user.view', target: row });
    return toUser(row);
  }

  /**
   * Tạo nhân viên. Có vai trò ADMIN thì schema đã bắt buộc `password`.
   * Đồng thời: hai request cùng email thì unique chặn một bên, bắt `P2002` đúng index email.
   */
  async create(actorId: string, body: CreateUserRequest): Promise<User> {
    const actor = await loadActor(this.prisma, actorId);
    assertAllowed(actor, { kind: 'user.create', assignments: body.assignments });
    const passwordHash = body.password === undefined ? null : await hashNewPassword(body.password);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await assertBranchesUsable(tx, body.assignments);
        const created = await tx.user.create({
          data: {
            email: body.email.toLowerCase(),
            fullName: body.fullName,
            phone: body.phone,
            passwordHash,
            branches: { create: [...body.assignments] },
          },
          include: USER_DETAIL,
        });
        await writeAudit(tx, {
          actorId,
          action: 'user.created',
          entityType: 'User',
          entityId: created.id,
          before: null,
          after: toAuditSnapshot(created),
        });
        return toUser(created);
      });
    } catch (error) {
      if (violatedUniqueIndex(error) === 'User_email_key') {
        throw invalidField('email', 'Email đã tồn tại');
      }
      throw error;
    }
  }

  /** Khoá lạc quan theo `version`. */
  async update(
    actorId: string,
    userId: string,
    { version, ...changes }: UpdateUserRequest,
  ): Promise<User> {
    return this.changeUser(await loadActor(this.prisma, actorId), userId, {
      kind: 'user.update',
      auditAction: 'user.updated',
      apply: async (tx) => {
        const { count } = await tx.user.updateMany({
          where: { id: userId, version },
          data: { ...changes, version: { increment: 1 } },
        });
        if (count === 0) {
          throw new BusinessError('VERSION_CONFLICT', 'Dữ liệu đã bị người khác sửa', 409);
        }
      },
    });
  }

  /** Khoá tài khoản và thu hồi mọi phiên. Không ai tự khoá chính mình; không được khoá ADMIN cuối cùng. */
  async lock(actorId: string, userId: string): Promise<User> {
    return this.changeUser(await loadActor(this.prisma, actorId), userId, {
      kind: 'user.lock',
      auditAction: 'user.locked',
      canRemoveAdmin: true,
      apply: async (tx) => {
        const { count } = await tx.user.updateMany({
          where: { id: userId, status: 'ACTIVE' },
          data: { status: 'LOCKED', version: { increment: 1 } },
        });
        if (count === 0) {
          throw invalidState('Tài khoản đã bị khoá');
        }
        await revokeAllSessions(tx, userId);
      },
    });
  }

  async unlock(actorId: string, userId: string): Promise<User> {
    return this.changeUser(await loadActor(this.prisma, actorId), userId, {
      kind: 'user.unlock',
      auditAction: 'user.unlocked',
      apply: async (tx) => {
        const { count } = await tx.user.updateMany({
          where: { id: userId, status: 'LOCKED' },
          data: { status: 'ACTIVE', version: { increment: 1 } },
        });
        if (count === 0) {
          throw invalidState('Tài khoản chưa bị khoá');
        }
      },
    });
  }

  /** Gỡ Google và thu hồi mọi phiên. ADMIN không có mật khẩu thì đây có thể là đường vào cuối cùng. */
  async unlinkGoogle(actorId: string, userId: string): Promise<User> {
    return this.changeUser(await loadActor(this.prisma, actorId), userId, {
      kind: 'user.unlink-google',
      auditAction: 'user.google_unlinked',
      canRemoveAdmin: true,
      apply: async (tx) => {
        const { count } = await tx.authIdentity.deleteMany({
          where: { userId, provider: 'GOOGLE' },
        });
        if (count === 0) {
          throw invalidState('Tài khoản chưa liên kết Google');
        }
        await bumpVersion(tx, userId);
        await revokeAllSessions(tx, userId);
      },
    });
  }

  /** Đặt lại mật khẩu của một ADMIN và thu hồi mọi phiên của người đó. */
  async resetPassword(
    actorId: string,
    userId: string,
    { newPassword }: ResetPasswordRequest,
  ): Promise<void> {
    const actor = await loadActor(this.prisma, actorId);
    // Truyền `target` ngay để chặn tự đặt lại trước khi chạy bcrypt; chỉ ADMIN qua được bước này.
    assertAllowed(actor, { kind: 'user.reset-password', target: { id: userId, branches: [] } });
    const passwordHash = await hashNewPassword(newPassword);
    await this.changeUser(actor, userId, {
      kind: 'user.reset-password',
      auditAction: 'user.password_reset',
      apply: async (tx, before) => {
        if (!hasAdminRole(before.branches)) {
          throw invalidState('Chỉ ADMIN có mật khẩu');
        }
        await tx.user.update({
          where: { id: userId },
          data: { passwordHash, version: { increment: 1 } },
        });
        await revokeAllSessions(tx, userId);
      },
    });
  }

  /**
   * Thay toàn bộ vai trò. Mật khẩu đi cùng vai trò ADMIN: thêm ADMIN phải kèm `password`, bỏ ADMIN thì xoá
   * `passwordHash`. Bớt bất kỳ vai trò nào → thu hồi mọi phiên, để token mới mang đúng vai trò.
   */
  async replaceAssignments(
    actorId: string,
    userId: string,
    { assignments, password }: ReplaceAssignmentsRequest,
  ): Promise<User> {
    const actor = await loadActor(this.prisma, actorId);
    assertAllowed(actor, { kind: 'user.assign' });
    const newHash = password === undefined ? undefined : await hashNewPassword(password);
    return this.changeUser(actor, userId, {
      kind: 'user.assign',
      auditAction: 'user.assignments_replaced',
      canRemoveAdmin: true,
      apply: async (tx, before) => {
        await assertBranchesUsable(tx, assignments);
        const isBecomingAdmin = hasAdminRole(assignments) && !hasAdminRole(before.branches);
        if (isBecomingAdmin && newHash === undefined) {
          throw invalidField('password', 'Thêm vai trò ADMIN phải đặt mật khẩu');
        }
        if (!isBecomingAdmin && newHash !== undefined) {
          throw invalidField('password', 'password chỉ dùng khi thêm vai trò ADMIN');
        }
        await tx.userBranch.deleteMany({ where: { userId } });
        await tx.userBranch.createMany({
          data: assignments.map((assignment) => ({ ...assignment, userId })),
        });
        await tx.user.update({
          where: { id: userId },
          data: {
            version: { increment: 1 },
            ...(hasAdminRole(assignments) ? {} : { passwordHash: null }),
            ...(newHash === undefined ? {} : { passwordHash: newHash }),
          },
        });
        if (losesAssignment(before.branches, assignments)) {
          await revokeAllSessions(tx, userId);
        }
      },
    });
  }

  /**
   * Khung chung của mọi thao tác sửa một user, trong một transaction:
   * 1. Khoá dòng trước khi đọc. Thao tác có thể bớt ADMIN khoá cả các ADMIN (`lockAdminsAndUser`).
   * 2. Đọc user đã khoá, kiểm quyền trên dữ liệu đó: MANAGER không thể chen lúc user vừa đổi chi nhánh.
   * 3. Thay đổi, đọc lại, kiểm ADMIN cuối cùng nếu user này là ADMIN, rồi ghi nhật ký.
   * Thu hồi phiên chạy sau khoá user, cùng thứ tự với refresh, nên token vừa xoay vòng cũng bị thu hồi.
   */
  private changeUser(actor: Actor, userId: string, change: UserChange): Promise<User> {
    return runWithLockRetry(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        if (change.canRemoveAdmin === true) {
          await lockAdminsAndUser(tx, userId);
        } else {
          await tx.$queryRaw`SELECT id FROM "auth"."User" WHERE id = ${userId}::uuid FOR UPDATE`;
        }
        const before = await this.loadUser(tx, userId);
        assertAllowed(actor, { kind: change.kind, target: before });
        await change.apply(tx, before);
        const after = await this.loadUser(tx, userId);
        if (change.canRemoveAdmin === true && hasAdminRole(before.branches)) {
          await assertAdminRemains(tx);
        }
        await writeAudit(tx, {
          actorId: actor.id,
          action: change.auditAction,
          entityType: 'User',
          entityId: userId,
          before: toAuditSnapshot(before),
          after: toAuditSnapshot(after),
        });
        return toUser(after);
      }),
    );
  }

  private async loadUser(db: Pick<Tx, 'user'>, userId: string): Promise<UserRow> {
    const row = await db.user.findUnique({ where: { id: userId }, include: USER_DETAIL });
    if (row === null) {
      throw new BusinessError('NOT_FOUND', 'Không tìm thấy nhân viên', 404);
    }
    return row;
  }
}
