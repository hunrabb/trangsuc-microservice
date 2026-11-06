import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import type { Role } from '@jewelry/contracts';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  createTestKeys,
  signHs256WithPublicKey,
  signNoneToken,
  signTestToken,
  TEST_AUDIENCE_BACKOFFICE,
  TEST_AUDIENCE_SHOP,
  TEST_ISSUER,
  type TestKeys,
} from '@jewelry/test-utils';
import { BusinessError } from '../errors/business-error.ts';
import { AUDIENCE_KEY, IS_PUBLIC_KEY, ROLES_KEY } from './decorators.ts';
import { type AuthUser, type JwtVerification, loadPublicKeys } from './jwt-verifier.ts';
import { JwtGuard } from './jwt.guard.ts';
import { resolveBranchId, RolesGuard } from './roles.guard.ts';

const BRANCH_A = randomUUID();
const BRANCH_B = randomUUID();

const isError = (status: number, code: string) => (error: unknown) => {
  assert.ok(error instanceof BusinessError, String(error));
  assert.equal(error.httpStatus, status);
  assert.equal(error.code, code);
  return true;
};
const isInvalid = isError(401, 'INVALID_TOKEN');
const isExpired = isError(401, 'TOKEN_EXPIRED');
const isForbidden = isError(403, 'FORBIDDEN');

function contextFor(request: object, metadata: Record<string, unknown> = {}): ExecutionContext {
  const handler = () => undefined;
  for (const [key, value] of Object.entries(metadata)) {
    Reflect.defineMetadata(key, value, handler);
  }
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('JwtGuard', () => {
  let keys: TestKeys;
  let guard: JwtGuard;

  before(() => {
    keys = createTestKeys();
    const verification: JwtVerification = {
      keys: loadPublicKeys(keys.publicKeysDir),
      issuer: TEST_ISSUER,
      audiences: { backoffice: TEST_AUDIENCE_BACKOFFICE, shop: TEST_AUDIENCE_SHOP },
    };
    guard = new JwtGuard(new Reflector(), verification);
  });

  const check = async (token: string) => {
    const request = { headers: { authorization: `Bearer ${token}` } } as {
      headers: { authorization: string };
      user?: AuthUser;
    };
    await guard.canActivate(contextFor(request));
    return request.user;
  };
  const now = () => Math.floor(Date.now() / 1000);

  it('token đúng: gắn req.user = { id, branches }', async () => {
    const sub = randomUUID();
    const branches = [{ branchId: BRANCH_A, role: 'MANAGER' }];
    assert.deepEqual(
      await check(await signTestToken(keys.privateKey, { claims: { sub, branches } })),
      {
        id: sub,
        branches,
      },
    );
  });

  it('sai chữ ký: ký bằng khoá khác', async () => {
    const other = createTestKeys();
    await assert.rejects(check(await signTestToken(other.privateKey)), isInvalid);
  });

  it('sai chữ ký: sửa payload sau khi ký', async () => {
    const [header, , signature] = (await signTestToken(keys.privateKey)).split('.');
    const forged = Buffer.from(
      JSON.stringify({
        sub: randomUUID(),
        branches: [{ branchId: null, role: 'ADMIN' }],
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE_BACKOFFICE,
        exp: now() + 900,
      }),
    ).toString('base64url');
    await assert.rejects(check(`${header}.${forged}.${signature}`), isInvalid);
  });

  it('hết hạn quá 30 giây: TOKEN_EXPIRED', async () => {
    const token = await signTestToken(keys.privateKey, { claims: { exp: now() - 31 } });
    await assert.rejects(check(token), isExpired);
  });

  it('hết hạn trong 30 giây cho phép lệch: vẫn nhận', async () => {
    assert.ok(await check(await signTestToken(keys.privateKey, { claims: { exp: now() - 25 } })));
  });

  it('token giả đã hết hạn không được báo TOKEN_EXPIRED', async () => {
    const other = createTestKeys();
    const token = await signTestToken(other.privateKey, { claims: { exp: now() - 3600 } });
    await assert.rejects(check(token), isInvalid);
  });

  it('alg: none', async () => {
    await assert.rejects(check(signNoneToken()), isInvalid);
    await assert.rejects(check(`${signNoneToken()}gia`), isInvalid);
  });

  it('alg: HS256 ký bằng public key', async () => {
    await assert.rejects(check(signHs256WithPublicKey(keys.publicPem)), isInvalid);
  });

  it('ký đúng khoá nhưng thuật toán khác RS256: từ chối', async () => {
    for (const alg of ['RS384', 'RS512', 'PS256'] as const) {
      await assert.rejects(check(await signTestToken(keys.privateKey, { alg })), isInvalid, alg);
    }
  });

  it('crit có phần mở rộng không hiểu: từ chối dù chữ ký đúng', async () => {
    const token = await signTestToken(keys.privateKey, { unknownCrit: true });
    await assert.rejects(check(token), isInvalid);
  });

  it('kid lạ, không có kid, kid trùng thuộc tính có sẵn', async () => {
    for (const kid of ['la', null, '__proto__', 'constructor']) {
      await assert.rejects(
        check(await signTestToken(keys.privateKey, { kid })),
        isInvalid,
        String(kid),
      );
    }
  });

  it('sai iss, sai aud', async () => {
    const wrongIss = await signTestToken(keys.privateKey, { claims: { iss: 'khac' } });
    const wrongAud = await signTestToken(keys.privateKey, { claims: { aud: 'khac' } });
    await assert.rejects(check(wrongIss), isInvalid);
    await assert.rejects(check(wrongAud), isInvalid);
  });

  it('aud dạng mảng có chứa audience thì nhận', async () => {
    const claims = { aud: ['khac', TEST_AUDIENCE_BACKOFFICE] };
    assert.ok(await check(await signTestToken(keys.privateKey, { claims })));
  });

  it('thiếu exp, nbf trong tương lai, sub sai dạng, branches sai', async () => {
    const bad = [
      { exp: undefined },
      { nbf: now() + 120 },
      { sub: 'khong-phai-uuid' },
      { branches: 'ADMIN' },
      { branches: [{ branchId: null, role: 'MANAGER' }] },
      { branches: [{ branchId: BRANCH_A, role: 'ADMIN' }] },
      { branches: [{ branchId: BRANCH_A, role: 'VUA' }] },
    ];
    for (const claims of bad) {
      const token = await signTestToken(keys.privateKey, { claims: claims as never });
      await assert.rejects(check(token), isInvalid, JSON.stringify(claims));
    }
  });

  it('không có header, sai scheme, chuỗi rác', async () => {
    const noHeader = contextFor({ headers: {} });
    await assert.rejects(guard.canActivate(noHeader), isInvalid);
    const basic = contextFor({ headers: { authorization: 'Basic abc' } });
    await assert.rejects(guard.canActivate(basic), isInvalid);
    for (const token of ['a.b', 'a.b.c', 'a.b.c.d', '!!.!!.!!', 'x'.repeat(9000)]) {
      await assert.rejects(check(token), isInvalid);
    }
  });

  it('token aud shop ở endpoint mặc định: INVALID_TOKEN', async () => {
    const token = await signTestToken(keys.privateKey, { audience: TEST_AUDIENCE_SHOP });
    await assert.rejects(check(token), isInvalid);
  });

  const checkShop = async (token: string) => {
    const request = { headers: { authorization: `Bearer ${token}` } };
    await guard.canActivate(contextFor(request, { [AUDIENCE_KEY]: 'shop' }));
    return (request as { user?: AuthUser }).user;
  };

  it('@Audience("shop"): nhận token khách, từ chối token nhân viên', async () => {
    const sub = randomUUID();
    const shopToken = await signTestToken(keys.privateKey, {
      audience: TEST_AUDIENCE_SHOP,
      claims: { sub, branches: [] },
    });
    assert.deepEqual(await checkShop(shopToken), { id: sub, branches: [] });
    await assert.rejects(checkShop(await signTestToken(keys.privateKey)), isInvalid);
  });

  it('aud lạ bị từ chối ở cả hai loại', async () => {
    const token = await signTestToken(keys.privateKey, { audience: 'khac' });
    await assert.rejects(check(token), isInvalid);
    await assert.rejects(checkShop(token), isInvalid);
  });

  it('@Public() bỏ qua kiểm tra', async () => {
    const context = contextFor({ headers: {} }, { [IS_PUBLIC_KEY]: true });
    assert.equal(await guard.canActivate(context), true);
  });

  it('hỗ trợ nhiều khoá cùng lúc khi đổi khoá', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jewelry-jwt-'));
    const oldKey = createTestKeys('cu');
    const newKey = createTestKeys('moi');
    writeFileSync(join(dir, 'cu.public.pem'), oldKey.publicPem);
    writeFileSync(join(dir, 'moi.public.pem'), newKey.publicPem);
    const loaded = loadPublicKeys(dir);
    assert.deepEqual([...loaded.keys()].sort(), ['cu', 'moi']);
  });
});

describe('loadPublicKeys', () => {
  const dirWith = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'jewelry-jwt-'));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return dir;
  };

  it('kid = tên file, bỏ qua file khác', () => {
    const { publicPem } = createTestKeys();
    const keys = loadPublicKeys(dirWith({ 'k9.public.pem': publicPem, 'ghi-chu.txt': 'x' }));
    assert.deepEqual([...keys.keys()], ['k9']);
  });

  it('thư mục trống hoặc không tồn tại: báo lỗi', () => {
    assert.throws(() => loadPublicKeys(dirWith({})), /Không có file/);
    assert.throws(() => loadPublicKeys('/khong/ton/tai'), /ENOENT/);
  });

  it('từ chối private key đặt nhầm vào thư mục public', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    assert.throws(() => loadPublicKeys(dirWith({ 'k.public.pem': pem })), /private key/);
  });

  it('từ chối khoá yếu hoặc không phải RSA', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey;
    for (const key of [weak, ec]) {
      const pem = key.export({ type: 'spki', format: 'pem' }).toString();
      assert.throws(() => loadPublicKeys(dirWith({ 'k.public.pem': pem })), /RSA/);
    }
  });
});

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());
  const manager = (branchId: string): AuthUser => ({
    id: randomUUID(),
    branches: [{ branchId, role: 'MANAGER' }],
  });
  const staff = (branchId: string): AuthUser => ({
    id: randomUUID(),
    branches: [{ branchId, role: 'STAFF' }],
  });
  const admin: AuthUser = { id: randomUUID(), branches: [{ branchId: null, role: 'ADMIN' }] };

  const run = (roles: Role[] | undefined, request: object) =>
    guard.canActivate(contextFor(request, roles ? { [ROLES_KEY]: roles } : {}));

  it('không có @Roles: chỉ cần đăng nhập', () => {
    assert.equal(run(undefined, { user: staff(BRANCH_A) }), true);
  });

  it('đúng vai trò, đúng chi nhánh: qua (param, query, body)', () => {
    const user = manager(BRANCH_A);
    assert.equal(run(['MANAGER'], { user, params: { branchId: BRANCH_A } }), true);
    assert.equal(run(['MANAGER'], { user, query: { branchId: BRANCH_A } }), true);
    assert.equal(run(['MANAGER'], { user, body: { branchId: BRANCH_A } }), true);
  });

  it('một trong các vai trò khai báo là đủ', () => {
    const request = { user: staff(BRANCH_A), params: { branchId: BRANCH_A } };
    assert.equal(run(['MANAGER', 'STAFF'], request), true);
  });

  it('đúng vai trò nhưng sai chi nhánh: 403', () => {
    const request = { user: manager(BRANCH_A), params: { branchId: BRANCH_B } };
    assert.throws(() => run(['MANAGER'], request), isForbidden);
  });

  it('đúng chi nhánh nhưng sai vai trò: 403', () => {
    const request = { user: staff(BRANCH_A), params: { branchId: BRANCH_A } };
    assert.throws(() => run(['MANAGER'], request), isForbidden);
  });

  it('vai trò ở chi nhánh này không dùng được cho chi nhánh khác', () => {
    const user: AuthUser = {
      id: randomUUID(),
      branches: [
        { branchId: BRANCH_A, role: 'STAFF' },
        { branchId: BRANCH_B, role: 'MANAGER' },
      ],
    };
    assert.throws(() => run(['MANAGER'], { user, params: { branchId: BRANCH_A } }), isForbidden);
    assert.equal(run(['MANAGER'], { user, params: { branchId: BRANCH_B } }), true);
  });

  it('request không nêu chi nhánh: 403 với vai trò theo chi nhánh', () => {
    assert.throws(() => run(['MANAGER'], { user: manager(BRANCH_A) }), isForbidden);
  });

  it('ADMIN qua mọi chi nhánh, kể cả khi @Roles không liệt kê, kể cả không nêu chi nhánh', () => {
    assert.equal(run(['MANAGER'], { user: admin, params: { branchId: BRANCH_A } }), true);
    assert.equal(run(['STAFF'], { user: admin, params: { branchId: BRANCH_B } }), true);
    assert.equal(run(['MANAGER'], { user: admin }), true);
  });

  it('chỉ @Roles("ADMIN"): người khác không qua', () => {
    const request = { user: manager(BRANCH_A), params: { branchId: BRANCH_A } };
    assert.throws(() => run(['ADMIN'], request), isForbidden);
  });

  it('không có user: 403', () => {
    assert.throws(() => run(['MANAGER'], { params: { branchId: BRANCH_A } }), isForbidden);
  });

  it('branchId ở hai nơi khác nhau: 403, kể cả có quyền ở một trong hai', () => {
    const request = {
      user: manager(BRANCH_A),
      query: { branchId: BRANCH_A },
      body: { branchId: BRANCH_B },
    };
    assert.throws(() => run(['MANAGER'], request), isForbidden);
  });

  it('branchId không phải chuỗi: 403', () => {
    const request = { user: manager(BRANCH_A), query: { branchId: [BRANCH_A, BRANCH_B] } };
    assert.throws(() => run(['MANAGER'], request), isForbidden);
  });
});

describe('resolveBranchId', () => {
  it('cùng giá trị ở nhiều nơi thì nhận; không có thì undefined; body không phải object thì bỏ qua', () => {
    const request = {
      params: { branchId: BRANCH_A },
      query: { branchId: BRANCH_A },
      body: { branchId: BRANCH_A },
    };
    assert.equal(resolveBranchId(request), BRANCH_A);
    assert.equal(resolveBranchId({ body: 'chuoi' }), undefined);
    assert.equal(resolveBranchId({}), undefined);
  });
});
