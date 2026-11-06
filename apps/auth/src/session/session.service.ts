import { BusinessError, getCorrelationId } from '@jewelry/common';
import type { AuthSession, BranchRole, CurrentUser } from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenService } from './access-token.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiry,
} from './tokens';

/** Hai tab refresh cùng lúc: bên thua chỉ cần gửi lại, cookie mới đã có trong trình duyệt. */
const REPLACEMENT_GRACE = Prisma.raw(`interval '10 seconds'`);
const ABSOLUTE_LIFETIME = Prisma.raw(`interval '30 days'`);

export interface ClientInfo {
  userAgent?: string;
  ip?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  branches: BranchRole[];
}

export interface OpenedSession {
  session: AuthSession;
  refreshToken: string;
  refreshExpiresAt: Date;
}

interface RotatedRow {
  userId: string;
  sessionStartedAt: Date;
  live: boolean;
}

interface StaleRow {
  userId: string;
  id: string;
  justReplaced: boolean;
  justRevoked: boolean;
}

type RefreshOutcome =
  | { kind: 'rotated'; user: SessionUser; token: string; expiresAt: Date }
  | { kind: 'reuse-detected' };

const sessionExpired = () =>
  new BusinessError('SESSION_EXPIRED', 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại', 401);

type Tx = Prisma.TransactionClient;

const USER_WITH_ROLES = {
  include: { branches: { select: { branchId: true, role: true } } },
} as const;

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessTokens: AccessTokenService,
  ) {}

  /** Mở phiên mới cho user đã được xác thực. Vai trò đọc lại ở nơi gọi, ngay trước khi phát token. */
  async open(user: SessionUser, client: ClientInfo): Promise<OpenedSession> {
    const now = new Date();
    const { token, expiresAt } = await this.createToken(this.prisma, user.id, now, client);
    return this.toOpenedSession(user, token, expiresAt);
  }

  /**
   * Xoay vòng refresh token. Thứ tự quan trọng:
   * - Hết hạn, user bị khoá...: ném lỗi TRONG transaction để hoàn tác việc xoay vòng. Nếu commit, token hết hạn
   *   sẽ có `replacedAt`, và cookie cũ gửi lại sau 10 giây bị coi nhầm là đánh cắp, thu hồi oan mọi phiên.
   * - Phát hiện dùng lại: trả kết quả ra ngoài rồi mới ném lỗi, để việc thu hồi và `AuditLog` được commit.
   */
  async refresh(rawToken: string, client: ClientInfo): Promise<OpenedSession> {
    const tokenHash = hashRefreshToken(rawToken);
    const outcome = await this.prisma.$transaction(async (tx): Promise<RefreshOutcome> => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      // UPDATE có điều kiện là trọng tài: hai request song song, bên sau chờ khoá rồi thấy 0 dòng.
      const [rotated] = await tx.$queryRaw<RotatedRow[]>`
        UPDATE "auth"."RefreshToken"
        SET "revokedAt" = now(), "replacedAt" = now(), "updatedAt" = now()
        WHERE "tokenHash" = ${tokenHash} AND "revokedAt" IS NULL
        RETURNING "userId", "sessionStartedAt",
          ("expiresAt" > now() AND "sessionStartedAt" + ${ABSOLUTE_LIFETIME} > now()) AS "live"`;
      if (rotated === undefined) {
        return this.handleStaleToken(tx, tokenHash);
      }
      if (!rotated.live) {
        throw sessionExpired();
      }
      const user = await this.loadActiveUser(tx, rotated.userId);
      if (user === undefined) {
        throw sessionExpired();
      }
      const created = await this.createToken(tx, user.id, rotated.sessionStartedAt, client);
      return { kind: 'rotated', user, ...created };
    });
    if (outcome.kind === 'reuse-detected') {
      throw sessionExpired();
    }
    return this.toOpenedSession(outcome.user, outcome.token, outcome.expiresAt);
  }

  /** Token không xoay vòng được. So thời gian bằng `now()` của DB, không phụ thuộc đồng hồ của service. */
  private async handleStaleToken(tx: Tx, tokenHash: string): Promise<RefreshOutcome> {
    const [stale] = await tx.$queryRaw<StaleRow[]>`
      SELECT id, "userId",
        COALESCE("replacedAt" > now() - ${REPLACEMENT_GRACE}, false) AS "justReplaced",
        COALESCE("revokedAt" > now() - ${REPLACEMENT_GRACE}, false) AS "justRevoked"
      FROM "auth"."RefreshToken"
      WHERE "tokenHash" = ${tokenHash}`;
    if (stale === undefined) {
      throw sessionExpired();
    }
    if (stale.justReplaced) {
      throw new BusinessError('REFRESH_CONFLICT', 'Phiên vừa được làm mới, vui lòng thử lại', 409);
    }
    if (stale.justRevoked) {
      // Vừa đăng xuất (có `revokedAt`, không có `replacedAt`) mà tab khác đang refresh: phiên đã kết thúc
      // đúng cách, không phải dấu hiệu đánh cắp, không được quét phiên ở máy khác.
      throw sessionExpired();
    }
    await tx.refreshToken.updateMany({
      where: { userId: stale.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actorId: stale.userId,
        action: 'session.token_reuse_detected',
        entityType: 'User',
        entityId: stale.userId,
        data: { refreshTokenId: stale.id },
        correlationId: getCorrelationId() ?? '',
      },
    });
    return { kind: 'reuse-detected' };
  }

  /** Không có cookie, hoặc token đã thu hồi thì vẫn coi là thành công. */
  async logout(rawToken: string | undefined): Promise<void> {
    if (rawToken === undefined) {
      return;
    }
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async currentUser(userId: string): Promise<CurrentUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { ...USER_WITH_ROLES.include, identities: { select: { provider: true } } },
    });
    if (user === null) {
      throw new BusinessError('INVALID_TOKEN', 'Token không hợp lệ', 401);
    }
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      branches: user.branches,
      googleLinked: user.identities.some((identity) => identity.provider === 'GOOGLE'),
    };
  }

  private async loadActiveUser(tx: Tx, userId: string): Promise<SessionUser | undefined> {
    const user = await tx.user.findUnique({ where: { id: userId }, ...USER_WITH_ROLES });
    if (user === null || user.status !== 'ACTIVE' || user.branches.length === 0) {
      return undefined;
    }
    return { id: user.id, email: user.email, fullName: user.fullName, branches: user.branches };
  }

  private async createToken(
    db: Pick<Tx, 'refreshToken'>,
    userId: string,
    sessionStartedAt: Date,
    client: ClientInfo,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = generateRefreshToken();
    const expiresAt = refreshExpiry(sessionStartedAt);
    await db.refreshToken.create({
      data: {
        userId,
        tokenHash: hashRefreshToken(token),
        expiresAt,
        sessionStartedAt,
        userAgent: client.userAgent?.slice(0, 512),
        ip: client.ip,
      },
    });
    return { token, expiresAt };
  }

  private async toOpenedSession(
    user: SessionUser,
    refreshToken: string,
    refreshExpiresAt: Date,
  ): Promise<OpenedSession> {
    return {
      session: {
        accessToken: await this.accessTokens.sign(user.id, user.branches),
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        user,
      },
      refreshToken,
      refreshExpiresAt,
    };
  }
}
