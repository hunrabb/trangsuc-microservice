import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Controller, Get, type INestApplication, Module, Param } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { createTestKeys, signTestToken, TEST_AUDIENCE, TEST_ISSUER } from '@jewelry/test-utils';
import { GlobalExceptionFilter } from '../errors/global-exception.filter.ts';
import { CurrentUser, Public, Roles } from './decorators.ts';
import { JwtAuthModule } from './jwt-auth.module.ts';
import type { AuthUser } from './jwt-verifier.ts';

// Unit test gọi guard trực tiếp không chứng minh được việc đăng ký: test này chạy qua HTTP thật.
const keys = createTestKeys();
const BRANCH_A = randomUUID();
const BRANCH_B = randomUUID();

@Controller()
class ProbeController {
  @Public()
  @Get('cong-khai')
  open(): { ok: true } {
    return { ok: true };
  }

  @Get('can-dang-nhap')
  protectedRoute(@CurrentUser() user: AuthUser): { id: string } {
    return { id: user.id };
  }

  @Roles('MANAGER')
  @Get('chi-nhanh/:branchId')
  branchRoute(@Param('branchId') branchId: string): { branchId: string } {
    return { branchId };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [
        () => ({
          JWT_PUBLIC_KEYS_DIR: keys.publicKeysDir,
          JWT_ISSUER: TEST_ISSUER,
          JWT_AUDIENCE: TEST_AUDIENCE,
        }),
      ],
    }),
    JwtAuthModule,
  ],
  controllers: [ProbeController],
})
class ProbeModule {}

describe('JwtAuthModule qua HTTP thật', () => {
  let app: INestApplication;
  let baseUrl: string;

  before(async () => {
    app = await NestFactory.create(ProbeModule, { logger: false });
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  after(async () => {
    await app.close();
  });

  const get = (path: string, token?: string) =>
    fetch(`${baseUrl}${path}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  const tokenFor = (branches: unknown, sub = randomUUID()) =>
    signTestToken(keys.privateKey, { claims: { sub, branches } });
  const manager = [{ branchId: BRANCH_A, role: 'MANAGER' }];

  it('mặc định cần đăng nhập, không cần khai báo gì trên endpoint', async () => {
    const response = await get('/can-dang-nhap');
    assert.equal(response.status, 401);
    assert.equal(((await response.json()) as { code: string }).code, 'INVALID_TOKEN');
  });

  it('@Public() đi qua không cần token', async () => {
    assert.equal((await get('/cong-khai')).status, 200);
  });

  it('@CurrentUser() nhận đúng user trong token', async () => {
    const sub = randomUUID();
    const response = await get('/can-dang-nhap', tokenFor(manager, sub));
    assert.deepEqual(await response.json(), { id: sub });
  });

  it('@Roles: đúng chi nhánh qua, sai chi nhánh 403 FORBIDDEN', async () => {
    assert.equal((await get(`/chi-nhanh/${BRANCH_A}`, tokenFor(manager))).status, 200);
    const denied = await get(`/chi-nhanh/${BRANCH_B}`, tokenFor(manager));
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as { code: string }).code, 'FORBIDDEN');
  });

  it('@Roles không có token: 401 chứ không phải 403 (JwtGuard chạy trước RolesGuard)', async () => {
    assert.equal((await get(`/chi-nhanh/${BRANCH_A}`)).status, 401);
  });

  it('ADMIN qua mọi chi nhánh', async () => {
    const admin = tokenFor([{ branchId: null, role: 'ADMIN' }]);
    assert.equal((await get(`/chi-nhanh/${BRANCH_B}`, admin)).status, 200);
  });
});
