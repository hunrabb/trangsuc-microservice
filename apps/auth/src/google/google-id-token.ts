import { BusinessError } from '@jewelry/common';
import { errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const CLOCK_SKEW_SECONDS = 30;

const googleClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.literal(true),
});

export interface GoogleIdentity {
  /** `sub` của Google: mã bền vững để ghép tài khoản. Email có thể đổi nên không dùng cho lần sau. */
  subject: string;
  /** Đã đưa về chữ thường. */
  email: string;
}

const invalid = () => new BusinessError('INVALID_CREDENTIALS', 'Đăng nhập không thành công', 401);

/** Lỗi của phía Google, không phải của token: báo 503 để client thử lại, không báo sai thông tin. */
const isKeyFetchFailure = (error: unknown): boolean =>
  error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError);

/** Kiểm ID token của Google. Sai bất kỳ điều kiện nào → `401 INVALID_CREDENTIALS`. */
export async function verifyGoogleIdToken(
  credential: string,
  keys: JWTVerifyGetKey,
  clientId: string,
): Promise<GoogleIdentity> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(credential, keys, {
      algorithms: ['RS256'],
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
      clockTolerance: CLOCK_SKEW_SECONDS,
      requiredClaims: ['sub', 'exp', 'email'],
    }));
  } catch (error) {
    if (isKeyFetchFailure(error)) {
      throw new BusinessError('SERVICE_UNAVAILABLE', 'Không xác minh được với Google lúc này', 503);
    }
    throw invalid();
  }
  const claims = googleClaimsSchema.safeParse(payload);
  if (!claims.success) {
    throw invalid();
  }
  return { subject: claims.data.sub, email: claims.data.email.toLowerCase() };
}
