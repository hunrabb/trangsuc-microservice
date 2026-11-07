import { isAcceptablePassword, PASSWORD_MIN_LENGTH, PASSWORD_MAX_BYTES } from '@jewelry/contracts';
import { hash } from 'bcryptjs';
import { z } from 'zod';
import { BCRYPT_ROUNDS } from '../password/hashing';

export class CreateAdminError extends Error {}

export interface CreateAdminInput {
  email: string;
  fullName: string;
  password: string;
}

/** Phần tối thiểu của Prisma client mà lệnh này cần. */
export interface CreateAdminDb {
  $transaction<T>(work: (tx: CreateAdminTx) => Promise<T>): Promise<T>;
}

export interface CreateAdminTx {
  user: { create(args: never): Promise<{ id: string }> };
  auditLog: { create(args: never): Promise<unknown> };
}

interface PrismaLikeError {
  code?: unknown;
  meta?: { modelName?: string };
}

/** Tạo ADMIN đầu tiên trong một transaction. Không in và không ghi mật khẩu ở bất kỳ đâu. */
export async function createAdmin(db: CreateAdminDb, input: CreateAdminInput): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  if (!z.email().safeParse(email).success) {
    throw new CreateAdminError(`Email không hợp lệ: ${email}`);
  }
  if (fullName === '') {
    throw new CreateAdminError('Thiếu họ tên');
  }
  if (!isAcceptablePassword(input.password)) {
    throw new CreateAdminError(
      `Mật khẩu phải có ít nhất ${PASSWORD_MIN_LENGTH} ký tự và tối đa ${PASSWORD_MAX_BYTES} byte`,
    );
  }
  const passwordHash = await hash(input.password, BCRYPT_ROUNDS);
  try {
    return await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, fullName, passwordHash, branches: { create: { role: 'ADMIN' } } },
      } as never);
      await tx.auditLog.create({
        data: {
          actorId: null,
          action: 'user.admin_created',
          entityType: 'User',
          entityId: user.id,
          data: { email, source: 'cli' },
          correlationId: 'cli',
        },
      } as never);
      return user.id;
    });
  } catch (error) {
    const prisma = error as PrismaLikeError | null;
    if (prisma?.code === 'P2002' && prisma.meta?.modelName === 'User') {
      throw new CreateAdminError(`Email đã tồn tại: ${email}`);
    }
    throw error;
  }
}
