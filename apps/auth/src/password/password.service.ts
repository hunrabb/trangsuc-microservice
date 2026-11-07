import { randomBytes, randomUUID } from 'node:crypto';
import { BusinessError, getCorrelationId } from '@jewelry/common';
import { type ChangePasswordRequest, isAcceptablePassword } from '@jewelry/contracts';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { type ClientInfo, type OpenedSession, SessionService } from '../session/session.service';
import { hashRefreshToken } from '../session/tokens';
import { BCRYPT_ROUNDS } from './hashing';

const invalidCredentials = () =>
  new BusinessError('INVALID_CREDENTIALS', 'Sai email hoặc mật khẩu', 401);

const SYSTEM_SCOPE = { branchId: null, role: 'ADMIN' } as const;

@Injectable()
export class PasswordService implements OnModuleInit {
  /** Hash của một chuỗi ngẫu nhiên, không ai biết mật khẩu gốc. */
  private decoyHash?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  /** Tạo hash giả một lần lúc khởi động, cùng chi phí với hash thật. */
  onModuleInit(): void {
    this.decoyHash = hash(randomBytes(32).toString('hex'), BCRYPT_ROUNDS);
  }

  /**
   * Chỉ ADMIN. Mọi trường hợp không thành công trả cùng một lỗi và tốn cùng thời gian: dù không có user
   * phù hợp vẫn chạy một lần bcrypt với hash giả, để không dò được email nào tồn tại qua thời gian phản hồi.
   */
  async login(email: string, password: string, client: ClientInfo): Promise<OpenedSession> {
    const normalized = email.toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
      include: { branches: { select: { branchId: true, role: true } } },
    });
    const eligible =
      user !== null &&
      user.status === 'ACTIVE' &&
      user.passwordHash !== null &&
      user.branches.some(
        ({ role, branchId }) => role === SYSTEM_SCOPE.role && branchId === SYSTEM_SCOPE.branchId,
      );
    const matched = await compare(
      password,
      eligible ? (user.passwordHash as string) : await (this.decoyHash as Promise<string>),
    );

    await this.prisma.auditLog.create({
      data: {
        actorId: user?.id ?? null,
        action:
          eligible && matched ? 'auth.password_login_succeeded' : 'auth.password_login_failed',
        // Email lạ không có bản ghi để gắn vào, nhưng vẫn phải lưu lại lần thử.
        entityType: user === null ? 'LoginAttempt' : 'User',
        entityId: user?.id ?? randomUUID(),
        data: { email: normalized, ip: client.ip ?? null },
        correlationId: getCorrelationId() ?? '',
      },
    });
    if (!eligible || !matched) {
      throw invalidCredentials();
    }
    return this.sessions.open(user.id, client, invalidCredentials);
  }

  /** Đổi mật khẩu và thu hồi mọi phiên khác trong một transaction; giữ phiên đang dùng. */
  async change(
    userId: string,
    { currentPassword, newPassword }: ChangePasswordRequest,
    currentRefreshToken: string | undefined,
    client: ClientInfo,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const currentHash = user?.passwordHash ?? null;
    if (currentHash === null || !(await compare(currentPassword, currentHash))) {
      throw invalidCredentials();
    }
    if (!isAcceptablePassword(newPassword) || newPassword === currentPassword) {
      throw new BusinessError(
        'PASSWORD_TOO_WEAK',
        'Mật khẩu mới phải có 12 ký tự trở lên, tối đa 72 byte và khác mật khẩu cũ',
        400,
      );
    }
    const passwordHash = await hash(newPassword, BCRYPT_ROUNDS);
    const keep =
      currentRefreshToken === undefined ? undefined : hashRefreshToken(currentRefreshToken);

    await this.prisma.$transaction(async (tx) => {
      // Điều kiện trên hash cũ: hai lần đổi song song chỉ một bên thắng, bên kia phải nhập lại.
      const { count } = await tx.user.updateMany({
        where: { id: userId, passwordHash: currentHash },
        data: { passwordHash, version: { increment: 1 } },
      });
      if (count === 0) {
        throw invalidCredentials();
      }
      await tx.refreshToken.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(keep === undefined ? {} : { tokenHash: { not: keep } }),
        },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actorId: userId,
          action: 'auth.password_changed',
          entityType: 'User',
          entityId: userId,
          data: { ip: client.ip ?? null },
          correlationId: getCorrelationId() ?? '',
        },
      });
    });
  }
}
