// CHỈ dùng trong test. Package này chỉ nằm ở devDependencies nên không có trong bản `deploy --prod`,
// và ESLint cấm import nó từ code chạy thật (xem eslint.config.mjs).
import { createHmac, generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_ISSUER = 'test-issuer';
export const TEST_AUDIENCE = 'test-audience';
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
    aud: TEST_AUDIENCE,
    iat: now,
    exp: now + 900,
  };
};

export interface SignOptions {
  /** `null` = không đặt `kid` trong header. */
  kid?: string | null;
  claims?: TestClaims;
}

/** Ký token RS256 như auth-service sẽ ký (cùng header + claims theo docs/thiet-ke.md). */
export function signTestToken(privateKey: KeyObject, options: SignOptions = {}): string {
  const kid = options.kid === undefined ? TEST_KID : options.kid;
  const header = { alg: 'RS256', typ: 'JWT', ...(kid === null ? {} : { kid }) };
  const data = `${encode(header)}.${encode({ ...defaultClaims(), ...options.claims })}`;
  return `${data}.${sign('sha256', Buffer.from(data), privateKey).toString('base64url')}`;
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
