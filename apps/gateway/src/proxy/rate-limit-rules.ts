const MINUTE_MS = 60_000;

export interface RateLimit {
  key: string;
  limit: number;
  ttlMs: number;
}

/**
 * Express không phân biệt hoa thường và chấp nhận dấu `/` cuối: `/auth/LOGIN/` vẫn tới `login`. So khớp trên
 * đường đã chuẩn hoá, nếu không đổi cách viết là lách được giới hạn.
 */
function normalizePath(path: string): string {
  const [pathname = ''] = path.split('?');
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Mã hoá hỏng: giữ nguyên, routes.ts đã từ chối từ trước.
  }
  return decoded.toLowerCase().replace(/\/+$/, '');
}

/** `email` trong body, chuẩn hoá như auth. Body hỏng thì coi là rỗng: giới hạn theo IP vẫn áp dụng. */
function emailOf(body: Buffer | undefined): string {
  try {
    const { email } = JSON.parse(body?.toString('utf8') ?? '') as { email?: unknown };
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

/** Các giới hạn áp dụng cho một request tới service, theo đường đã viết lại. */
export function rateLimitsFor(
  method: string,
  servicePath: string,
  clientIp: string,
  body: Buffer | undefined,
): RateLimit[] {
  if (method !== 'POST') {
    return [];
  }
  switch (normalizePath(servicePath)) {
    case '/auth/login':
      return [
        { key: `login:ip+email:${clientIp}:${emailOf(body)}`, limit: 5, ttlMs: MINUTE_MS },
        { key: `login:ip:${clientIp}`, limit: 20, ttlMs: MINUTE_MS },
      ];
    case '/auth/google':
      return [{ key: `google:ip:${clientIp}`, limit: 20, ttlMs: MINUTE_MS }];
    case '/auth/refresh':
      return [{ key: `refresh:ip:${clientIp}`, limit: 60, ttlMs: MINUTE_MS }];
    default:
      return [];
  }
}
