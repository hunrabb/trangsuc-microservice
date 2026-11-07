import { BusinessError, ConfigService, getCorrelationId } from '@jewelry/common';
import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { type ClientInfo, type OpenedSession, SessionService } from '../session/session.service';
import { type GoogleIdentity, verifyGoogleIdToken } from './google-id-token';

const WITH_ROLES = { branches: { select: { branchId: true, role: true } } } as const;

const notProvisioned = () =>
  new BusinessError('ACCOUNT_NOT_PROVISIONED', 'Tài khoản chưa được cấp quyền', 403);

interface PrismaLikeError {
  code?: unknown;
  meta?: { modelName?: string };
}

const isIdentityConflict = (error: unknown): boolean => {
  const prisma = error as PrismaLikeError | null;
  return prisma?.code === 'P2002' && prisma.meta?.modelName === 'AuthIdentity';
};

@Injectable()
export class GoogleLoginService {
  private readonly keys: JWTVerifyGetKey;
  private readonly clientId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    config: ConfigService<Env, true>,
  ) {
    this.keys = createRemoteJWKSet(new URL(config.get('GOOGLE_JWKS_URL', { infer: true })));
    this.clientId = config.get('GOOGLE_CLIENT_ID', { infer: true });
  }

  /**
   * Đăng nhập bằng ID token của Google: kiểm token, ghép tài khoản nếu là lần đầu, rồi mở phiên.
   * Đồng thời: nhiều request đầu tiên cùng lúc do `linkIfFirstLogin` xử lý; ở đây đọc lại sau bước ghép nên
   * bên thắng và bên thua đều thấy cùng dữ liệu mới nhất.
   */
  async login(credential: string, client: ClientInfo): Promise<OpenedSession> {
    const identity = await verifyGoogleIdToken(credential, this.keys, this.clientId);
    await this.linkIfFirstLogin(identity);
    // Luôn đọc lại sau bước ghép: trạng thái và vai trò phải là mới nhất, kể cả bên thua cuộc đua.
    const linked = await this.prisma.authIdentity.findUnique({
      where: { provider_subject: { provider: 'GOOGLE', subject: identity.subject } },
      include: { user: { include: WITH_ROLES } },
    });
    const user = linked?.user;
    if (user === undefined || user.status !== 'ACTIVE' || user.branches.length === 0) {
      throw notProvisioned();
    }
    return this.sessions.open(user.id, client, notProvisioned);
  }

  /** Lần đầu: ghép theo email với user đã được thêm trước. Không có user phù hợp thì không tạo gì. */
  private async linkIfFirstLogin({ subject, email }: GoogleIdentity): Promise<void> {
    const existing = await this.prisma.authIdentity.findUnique({
      where: { provider_subject: { provider: 'GOOGLE', subject } },
    });
    if (existing !== null) {
      return;
    }
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { ...WITH_ROLES, identities: { where: { provider: 'GOOGLE' } } },
    });
    if (user === null || user.status !== 'ACTIVE' || user.branches.length === 0) {
      throw notProvisioned();
    }
    const [linked] = user.identities;
    if (linked !== undefined) {
      // Cùng `sub`: request song song vừa ghép xong sau bước tra cứu ở trên, coi như thành công.
      if (linked.subject === subject) {
        return;
      }
      throw notProvisioned();
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.authIdentity.create({ data: { userId: user.id, provider: 'GOOGLE', subject } });
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: 'auth.google_linked',
            entityType: 'User',
            entityId: user.id,
            data: { provider: 'GOOGLE' },
            correlationId: getCorrelationId() ?? '',
          },
        });
      });
    } catch (error) {
      // Hai lần đăng nhập đầu tiên song song: unique là trọng tài, bên thua đọc lại ở `login`.
      if (!isIdentityConflict(error)) {
        throw error;
      }
    }
  }
}
