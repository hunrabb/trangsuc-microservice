import { createHash, randomBytes } from 'node:crypto';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_COOKIE = 'rt_bo';
export const REFRESH_COOKIE_PATH = '/api/auth';

const REFRESH_TOKEN_BYTES = 32;
const SLIDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/** DB chỉ giữ bản băm: lộ bảng `RefreshToken` không dùng được để đăng nhập. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Hạn trượt 7 ngày nhưng không vượt hạn tuyệt đối 30 ngày tính từ `sessionStartedAt`. */
export function refreshExpiry(sessionStartedAt: Date, now: Date = new Date()): Date {
  const sliding = now.getTime() + SLIDING_TTL_MS;
  const absolute = sessionStartedAt.getTime() + ABSOLUTE_TTL_MS;
  return new Date(Math.min(sliding, absolute));
}

const COOKIE_ATTRIBUTES = `HttpOnly; Secure; SameSite=Strict; Path=${REFRESH_COOKIE_PATH}`;

export function refreshCookie(token: string, expiresAt: Date, now: Date = new Date()): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return `${REFRESH_COOKIE}=${token}; Max-Age=${maxAge}; ${COOKIE_ATTRIBUTES}`;
}

export function clearedRefreshCookie(): string {
  return `${REFRESH_COOKIE}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`;
}

/** Đọc cookie refresh từ header `Cookie`. Giá trị là base64url nên không cần giải mã. */
export function readRefreshCookie(header: string | undefined): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === REFRESH_COOKIE) {
      const value = part.slice(separator + 1).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}
