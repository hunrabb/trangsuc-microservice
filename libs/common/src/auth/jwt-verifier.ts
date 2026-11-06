import { createPublicKey, type KeyObject } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accessTokenClaimsSchema, type BranchRole } from '@jewelry/contracts';
import { errors, type JWTPayload, jwtVerify } from 'jose';
import { BusinessError } from '../errors/business-error';

const PUBLIC_KEY_SUFFIX = '.public.pem';
const MIN_RSA_BITS = 2048;
/** Độ lệch đồng hồ tối đa giữa các service (docs/thiet-ke.md). */
export const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LENGTH = 8192;

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

/**
 * Kiểm tra chữ ký và claim chuẩn bằng `jose`. `algorithms` cố định RS256; `exp` phải khai báo bắt buộc
 * vì `jwtVerify` mặc định coi nó là tuỳ chọn. Chữ ký được kiểm trước mọi claim, nên chỉ token thật do
 * auth ký mới có thể nhận `TOKEN_EXPIRED`.
 */
async function verifySignedPayload(token: string, options: JwtVerification): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(
      token,
      ({ kid }) => {
        const key = kid === undefined ? undefined : options.keys.get(kid);
        if (key === undefined) {
          throw invalid();
        }
        return key;
      },
      {
        algorithms: ['RS256'],
        issuer: options.issuer,
        audience: options.audience,
        clockTolerance: CLOCK_SKEW_SECONDS,
        requiredClaims: ['exp'],
      },
    );
    return payload;
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      throw new BusinessError('TOKEN_EXPIRED', 'Token đã hết hạn', 401);
    }
    throw invalid();
  }
}

/** Kiểm tra access token, trả về user; sai → `401`. Claims nghiệp vụ được kiểm sau chữ ký. */
export async function verifyAccessToken(
  token: string,
  options: JwtVerification,
): Promise<AuthUser> {
  if (token.length > MAX_TOKEN_LENGTH) {
    throw invalid();
  }
  const payload = await verifySignedPayload(token, options);
  const claims = accessTokenClaimsSchema.safeParse(payload);
  if (!claims.success) {
    throw invalid();
  }
  return { id: claims.data.sub, branches: claims.data.branches };
}
