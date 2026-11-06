// CHỈ dùng trong test. Package này chỉ nằm ở devDependencies nên không có trong bản `deploy --prod`,
// và ESLint cấm import nó từ code chạy thật (xem eslint.config.mjs).
import { createHmac, generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';

export const TEST_ISSUER = 'test-issuer';
export const TEST_AUDIENCE_BACKOFFICE = 'test-backoffice';
export const TEST_AUDIENCE_SHOP = 'test-shop';
export const TEST_KID = 'test-kid';

export interface TestKeys {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicPem: string;
  /** Thư mục tạm chứa `<kid>.public.pem`, dùng làm JWT_PUBLIC_KEYS_DIR. */
  publicKeysDir: string;
}

export function createTestKeys(kid: string = TEST_KID): TestKeys {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const publicKeysDir = mkdtempSync(join(tmpdir(), 'jewelry-jwt-'));
  writeFileSync(join(publicKeysDir, `${kid}.public.pem`), publicPem);
  return { kid, privateKey, publicKey, publicPem, publicKeysDir };
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export interface TestClaims {
  sub?: string;
  branches?: unknown;
  iss?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number;
  nbf?: number;
}

const defaultClaims = (): Required<Omit<TestClaims, 'nbf'>> => {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: randomUUID(),
    branches: [{ branchId: null, role: 'ADMIN' }],
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE_BACKOFFICE,
    iat: now,
    exp: now + 900,
  };
};

export interface SignOptions {
  /** `null` = không đặt `kid` trong header. */
  kid?: string | null;
  claims?: TestClaims;
  /** Giá trị `aud`; mặc định token nhân viên. */
  audience?: string;
  /** Mặc định RS256. Đổi để thử token ký đúng khoá nhưng sai thuật toán. */
  alg?: 'RS256' | 'RS384' | 'RS512' | 'PS256';
  /** Thêm phần mở rộng `crit` mà bên kiểm tra không hiểu. */
  unknownCrit?: boolean;
}

/** Ký token RS256 như auth-service sẽ ký (cùng header + claims theo docs/thiet-ke.md). */
export function signTestToken(privateKey: KeyObject, options: SignOptions = {}): Promise<string> {
  const kid = options.kid === undefined ? TEST_KID : options.kid;
  const header = {
    alg: options.alg ?? 'RS256',
    typ: 'JWT',
    ...(kid === null ? {} : { kid }),
    ...(options.unknownCrit ? { crit: ['x-la'], 'x-la': true } : {}),
  };
  const audience = options.audience === undefined ? {} : { aud: options.audience };
  return new SignJWT({ ...defaultClaims(), ...audience, ...options.claims })
    .setProtectedHeader(header)
    .sign(privateKey, options.unknownCrit ? { crit: { 'x-la': true } } : undefined);
}

export interface TestKeyFiles extends TestKeys {
  /** File private key tạm, dùng làm JWT_PRIVATE_KEY_PATH. */
  privateKeyPath: string;
}

/** Như `createTestKeys`, kèm file private key cho service `auth` chạy thật. */
export function createTestKeyFiles(kid: string = TEST_KID): TestKeyFiles {
  const keys = createTestKeys(kid);
  const privateKeyPath = join(keys.publicKeysDir, `${kid}.private.key`);
  writeFileSync(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { ...keys, privateKeyPath };
}

export interface GoogleIssuer {
  /** Nội dung JWKS, phục vụ từ server giả hoặc `createLocalJWKSet`. */
  jwks: { keys: Record<string, unknown>[] };
  /** Ký ID token. Claim đặt `undefined` thì bị bỏ khỏi token. */
  sign(claims: Record<string, unknown>): Promise<string>;
}

/** Giả lập Google: test tự động không bao giờ gọi Google thật. */
export function createGoogleIssuer(): GoogleIssuer {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  return {
    jwks: { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] },
    sign: (claims) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({
        iss: 'https://accounts.google.com',
        email_verified: true,
        iat: now,
        exp: now + 3600,
        ...claims,
      })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
        .sign(privateKey);
    },
  };
}

/** Token không có chữ ký, `alg: none`. */
export function signNoneToken(kid: string = TEST_KID): string {
  const header = { alg: 'none', typ: 'JWT', kid };
  return `${encode(header)}.${encode(defaultClaims())}.`;
}

/** Tấn công đổi thuật toán: `alg: HS256`, dùng chính public key làm khoá bí mật. */
export function signHs256WithPublicKey(publicPem: string, kid: string = TEST_KID): string {
  const header = { alg: 'HS256', typ: 'JWT', kid };
  const data = `${encode(header)}.${encode(defaultClaims())}`;
  return `${data}.${createHmac('sha256', publicPem).update(data).digest('base64url')}`;
}
