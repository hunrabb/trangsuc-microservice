import { createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { accessTokenClaimsSchema, type BranchRole, type TokenAudience } from '@jewelry/contracts';
import { errors, type JWTPayload, jwtVerify } from 'jose';
import { BusinessError } from '../errors/business-error';

const MIN_RSA_BITS = 2048;
/** Độ lệch đồng hồ tối đa giữa các service (docs/thiet-ke.md). */
export const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LENGTH = 8192;

export interface AuthUser {
  id: string;
  branches: BranchRole[];
}

export interface JwtVerification {
  /** Public key duy nhất của hệ thống. */
  publicKey: KeyObject;
  issuer: string;
  /** Loại token → giá trị `aud`. */
  audiences: Readonly<Record<TokenAudience, string>>;
}

/** Đọc public key từ file. File hỏng, nhầm private key hoặc khoá yếu → ném lỗi, service không bật. */
export function loadPublicKey(path: string): KeyObject {
  const pem = readFileSync(path, 'utf8');
  // createPublicKey nhận cả private key và tự suy ra public: phải chặn tường minh.
  if (pem.includes('PRIVATE KEY')) {
    throw new Error(`${path} chứa private key, từ chối nạp`);
  }
  const key = createPublicKey(pem);
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== 'rsa' || bits < MIN_RSA_BITS) {
    throw new Error(`${path} phải là khoá RSA tối thiểu ${MIN_RSA_BITS} bit`);
  }
  return key;
}

const invalid = () => new BusinessError('INVALID_TOKEN', 'Token không hợp lệ', 401);

/**
 * Kiểm tra chữ ký bằng đúng một public key và claim chuẩn bằng `jose`. `algorithms` cố định RS256; `exp` phải khai báo bắt buộc
 * vì `jwtVerify` mặc định coi nó là tuỳ chọn. Chữ ký được kiểm trước mọi claim, nên chỉ token thật do
 * auth ký mới có thể nhận `TOKEN_EXPIRED`.
 */
async function verifySignedPayload(
  token: string,
  options: JwtVerification,
  audience: TokenAudience,
): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, options.publicKey, {
      algorithms: ['RS256'],
      issuer: options.issuer,
      audience: options.audiences[audience],
      clockTolerance: CLOCK_SKEW_SECONDS,
      requiredClaims: ['exp'],
    });
    return payload;
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      throw new BusinessError('TOKEN_EXPIRED', 'Token đã hết hạn', 401);
    }
    throw invalid();
  }
}

/**
 * Kiểm tra access token, trả về user; sai → `401`. Claims nghiệp vụ được kiểm sau chữ ký.
 * `aud` phải đúng loại token mà đường dẫn yêu cầu: token của khách không dùng được ở đường của nhân viên.
 */
export async function verifyAccessToken(
  token: string,
  options: JwtVerification,
  audience: TokenAudience,
): Promise<AuthUser> {
  if (token.length > MAX_TOKEN_LENGTH) {
    throw invalid();
  }
  const payload = await verifySignedPayload(token, options, audience);
  const claims = accessTokenClaimsSchema.safeParse(payload);
  if (!claims.success) {
    throw invalid();
  }
  return { id: claims.data.sub, branches: claims.data.branches };
}
