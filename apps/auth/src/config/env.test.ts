import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEnv as parse } from '@jewelry/common';
import { envSchema } from './env.ts';

const parseEnv = (raw: Record<string, unknown>) => parse(envSchema, raw);

const valid = {
  PORT: '3000',
  DATABASE_URL: 'postgresql://auth_user:s3cret@postgres:5432/jewelry?schema=auth',
  JWT_PUBLIC_KEYS_DIR: '/run/secrets/jwt-public',
  JWT_ISSUER: 'auth-service',
  JWT_AUDIENCE: 'store-system',
  // Chỉ cần một file đọc được.
  JWT_PRIVATE_KEY_PATH: process.execPath,
  JWT_ACTIVE_KID: 'k1',
};

describe('parseEnv (auth)', () => {
  it('chấp nhận cấu hình hợp lệ và đổi PORT sang số', () => {
    const result = parseEnv(valid);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.env.PORT, 3000);
      assert.equal(result.env.NODE_ENV, 'development');
    }
  });

  it('báo đúng tên biến bị thiếu', () => {
    const result = parseEnv({});
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.problems.map((p) => p.variable).sort(), [
        'DATABASE_URL',
        'JWT_ACTIVE_KID',
        'JWT_AUDIENCE',
        'JWT_ISSUER',
        'JWT_PRIVATE_KEY_PATH',
        'JWT_PUBLIC_KEYS_DIR',
        'PORT',
      ]);
    }
  });

  it('từ chối URL không có mật khẩu', () => {
    const result = parseEnv({
      ...valid,
      DATABASE_URL: 'postgresql://auth_user:@postgres:5432/jewelry?schema=auth',
    });
    assert.equal(result.ok, false);
  });

  it('từ chối URL trỏ sai schema', () => {
    const result = parseEnv({
      ...valid,
      DATABASE_URL: 'postgresql://auth_user:s3cret@postgres:5432/jewelry?schema=public',
    });
    assert.equal(result.ok, false);
  });

  it('từ chối JWT_PRIVATE_KEY_PATH không đọc được', () => {
    const result = parseEnv({ ...valid, JWT_PRIVATE_KEY_PATH: '/khong/ton/tai.pem' });
    assert.equal(result.ok, false);
  });

  it('từ chối PORT không phải số', () => {
    assert.equal(parseEnv({ ...valid, PORT: 'abc' }).ok, false);
  });
});
