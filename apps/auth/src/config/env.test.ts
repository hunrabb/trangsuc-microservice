import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEnv as parse } from '@jewelry/common';
import { envSchema } from './env.ts';

const parseEnv = (raw: Record<string, unknown>) => parse(envSchema, raw);

const valid = {
  PORT: '3000',
  DATABASE_URL: 'postgresql://auth_user:s3cret@postgres:5432/jewelry?schema=auth',
  DATABASE_POOL_MAX: '20',
  RABBITMQ_URL: 'amqp://jewelry_app:s3cret@rabbitmq:5672',
  JWT_PUBLIC_KEYS_DIR: '/run/secrets/jwt-public',
  JWT_ISSUER: 'auth-service',
  JWT_AUDIENCE_BACKOFFICE: 'store-backoffice',
  JWT_AUDIENCE_SHOP: 'store-shop',
  // Chỉ cần một file đọc được.
  JWT_PRIVATE_KEY_PATH: process.execPath,
  JWT_ACTIVE_KID: 'k1',
  GOOGLE_CLIENT_ID: 'client-test',
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
        'DATABASE_POOL_MAX',
        'DATABASE_URL',
        'GOOGLE_CLIENT_ID',
        'JWT_ACTIVE_KID',
        'JWT_AUDIENCE_BACKOFFICE',
        'JWT_AUDIENCE_SHOP',
        'JWT_ISSUER',
        'JWT_PRIVATE_KEY_PATH',
        'JWT_PUBLIC_KEYS_DIR',
        'PORT',
        'RABBITMQ_URL',
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

  it('GOOGLE_JWKS_URL mặc định là địa chỉ của Google, test trỏ đi nơi khác được', () => {
    const standard = parseEnv(valid);
    assert.ok(standard.ok);
    assert.equal(standard.env.GOOGLE_JWKS_URL, 'https://www.googleapis.com/oauth2/v3/certs');
    const fake = parseEnv({ ...valid, GOOGLE_JWKS_URL: 'http://127.0.0.1:9999/jwks' });
    assert.ok(fake.ok);
    assert.equal(fake.env.GOOGLE_JWKS_URL, 'http://127.0.0.1:9999/jwks');
  });

  it('từ chối PORT không phải số', () => {
    assert.equal(parseEnv({ ...valid, PORT: 'abc' }).ok, false);
  });
});
