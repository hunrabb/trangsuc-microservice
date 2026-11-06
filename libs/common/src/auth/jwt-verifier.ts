import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accessTokenClaimsSchema, type BranchRole } from '@jewelry/contracts';
import { BusinessError } from '../errors/business-error';

const PUBLIC_KEY_SUFFIX = '.public.pem';
const MIN_RSA_BITS = 2048;
/** Độ lệch đồng hồ tối đa giữa các service (docs/thiet-ke.md). */
export const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LENGTH = 8192;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

export interface AuthUser {
  id: string;
  branches: BranchRole[];
}

export interface JwtVerification {
  /** `kid` → public key. Dùng Map để `kid` như `__proto__` không trúng thuộc tính có sẵn. */
  keys: ReadonlyMap<string, KeyObject>;
  issuer: string;
  audience: string;
}

/** Đọc mọi `<kid>.public.pem` trong thư mục. Không có khoá hợp lệ → ném lỗi, service không bật. */
export function loadPublicKeys(dir: string): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(PUBLIC_KEY_SUFFIX))) {
    const pem = readFileSync(join(dir, file), 'utf8');
    // createPublicKey nhận cả private key và tự suy ra public: phải chặn tường minh.
    if (pem.includes('PRIVATE KEY')) {
      throw new Error(`${file} chứa private key, từ chối nạp`);
    }
    const key = createPublicKey(pem);
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (key.asymmetricKeyType !== 'rsa' || bits < MIN_RSA_BITS) {
      throw new Error(`${file} phải là khoá RSA tối thiểu ${MIN_RSA_BITS} bit`);
    }
    keys.set(file.slice(0, -PUBLIC_KEY_SUFFIX.length), key);
  }
  if (keys.size === 0) {
    throw new Error(`Không có file *${PUBLIC_KEY_SUFFIX} nào trong ${dir}`);
  }
  return keys;
}

const invalid = () => new BusinessError('INVALID_TOKEN', 'Token không hợp lệ', 401);

function decodeJson(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid();
  }
  return value as Record<string, unknown>;
}

function matchesAudience(aud: unknown, audience: string): boolean {
  return Array.isArray(aud) ? aud.includes(audience) : aud === audience;
}

/**
 * Kiểm tra access token, trả về user; sai → `401`. Thứ tự có ý nghĩa: chữ ký được kiểm trước mọi claim,
 * nên chỉ token thật do auth ký mới có thể nhận `TOKEN_EXPIRED`.
 *
 * Thuật toán cố định là RS256: `alg` trong header chỉ được so khớp đúng chuỗi đó và không bao giờ
 * quyết định cách kiểm chữ ký, nên `none` hay `HS256` ký bằng public key không có đường đi.
 */
export function verifyAccessToken(token: string, options: JwtVerification): AuthUser {
  const parts = token.split('.');
  if (
    token.length > MAX_TOKEN_LENGTH ||
    parts.length !== 3 ||
    !parts.every((part) => SEGMENT.test(part))
  ) {
    throw invalid();
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeJson(headerPart);
  // `crit` đòi hiểu phần mở rộng mà bên kiểm tra không hỗ trợ: RFC 7515 bắt buộc từ chối.
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || 'crit' in header) {
    throw invalid();
  }
  const key = options.keys.get(header.kid);
  if (key === undefined) {
    throw invalid();
  }
  const signed = Buffer.from(`${headerPart}.${payloadPart}`);
  if (!verify('sha256', signed, key, Buffer.from(signaturePart, 'base64url'))) {
    throw invalid();
  }

  const payload = decodeJson(payloadPart);
  if (payload.iss !== options.issuer || !matchesAudience(payload.aud, options.audience)) {
    throw invalid();
  }
  const now = Date.now() / 1000;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw invalid();
  }
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number' || payload.nbf > now + CLOCK_SKEW_SECONDS) {
      throw invalid();
    }
  }
  if (now > payload.exp + CLOCK_SKEW_SECONDS) {
    throw new BusinessError('TOKEN_EXPIRED', 'Token đã hết hạn', 401);
  }

  const claims = accessTokenClaimsSchema.safeParse(payload);
  if (!claims.success) {
    throw invalid();
  }
  return { id: claims.data.sub, branches: claims.data.branches };
}
