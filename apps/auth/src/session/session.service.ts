import { BusinessError, getCorrelationId } from '@jewelry/common';
import type { AuthSession, BranchRole, CurrentUser } from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenService } from './access-token.service';
import { ACTIVE_ASSIGNMENTS } from './active-assignments';
import { toCurrentUserBranches } from './current-user';
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

const USER_WITH_ROLES = { include: { branches: ACTIVE_ASSIGNMENTS } };

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessTokens: AccessTokenService,
  ) {}

  /**
   * Mở phiên mới cho user đã được xác thực. Không còn hợp lệ thì ném lỗi do nơi gọi chọn.
   * Đồng thời: giữ `FOR SHARE` trên user rồi mới đọc trạng thái và vai trò. Nếu đọc trước, request có thể
   * thấy `ACTIVE`, chờ admin khoá user xong rồi mới chèn token: token này không bị thu hồi. Có khoá thì
   * hoặc thấy trạng thái mới, hoặc admin phải chờ token này commit rồi thu hồi luôn nó.
   */
  async open(
    userId: string,
    client: ClientInfo,
    notAllowed: () => BusinessError,
  ): Promise<OpenedSession> {
    const { user, token, expiresAt } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await tx.$queryRaw`SELECT id FROM "auth"."User" WHERE id = ${userId}::uuid FOR SHARE`;
      const active = await this.loadActiveUser(tx, userId);
      if (active === undefined) {
        throw notAllowed();
      }
      return {
        user: active,
        ...(await this.createToken(tx, active.id, new Date(), client)),
      };
    });
    return this.toOpenedSession(user, token, expiresAt);
  }

  /**
   * Xoay vòng refresh token. Thứ tự quan trọng:
   * - Hết hạn, user bị khoá...: ném lỗi TRONG transaction để hoàn tác việc xoay vòng. Nếu commit, token hết hạn
   *   sẽ có `replacedAt`, và cookie cũ gửi lại sau 10 giây bị coi nhầm là đánh cắp, thu hồi oan mọi phiên.
   * - Phát hiện dùng lại: trả kết quả ra ngoài rồi mới ném lỗi, để việc thu hồi và `AuditLog` được commit.
   * - Giữ `FOR SHARE` trên user TRƯỚC khi đụng vào token, cùng thứ tự với thao tác quản trị (user rồi token).
   *   Ngược thứ tự thì refresh giữ token chờ user, admin giữ user chờ token: deadlock.
   */
  async refresh(rawToken: string, client: ClientInfo): Promise<OpenedSession> {
    const tokenHash = hashRefreshToken(rawToken);
    const outcome = await this.prisma.$transaction(async (tx): Promise<RefreshOutcome> => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await tx.$queryRaw`
        SELECT u.id FROM "auth"."User" u
        JOIN "auth"."RefreshToken" t ON t."userId" = u.id
        WHERE t."tokenHash" = ${tokenHash}
        FOR SHARE OF u`;
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

  /** Thu hồi mọi phiên của user. Access token đang dùng vẫn hiệu lực tới khi hết hạn, tối đa 15 phút. */
  async logoutAll(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Dữ liệu cho `GET /me`, đọc từ DB nên phản ánh vai trò mới nhất, không phải vai trò trong token. */
  async currentUser(userId: string): Promise<CurrentUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        branches: {
          ...ACTIVE_ASSIGNMENTS,
          select: { ...ACTIVE_ASSIGNMENTS.select, branch: { select: { name: true } } },
        },
        identities: { select: { provider: true } },
      },
    });
    if (user === null) {
      throw new BusinessError('INVALID_TOKEN', 'Token không hợp lệ', 401);
    }
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      branches: toCurrentUserBranches(user.branches),
      googleLinked: user.identities.some((identity) => identity.provider === 'GOOGLE'),
    };
  }

  /**
   * User còn được phép có phiên: tồn tại, `ACTIVE`, còn ít nhất một vai trò hiệu lực (`ACTIVE_ASSIGNMENTS`).
   * Không đạt trả `undefined`. Vai trò ở chi nhánh đã ngừng hoạt động không vào token.
   */
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
