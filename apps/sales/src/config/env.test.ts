import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEnv as parse } from '@jewelry/common';
import { envSchema } from './env.ts';

const parseEnv = (raw: Record<string, unknown>) => parse(envSchema, raw);

const valid = {
  PORT: '3000',
  DATABASE_URL: 'postgresql://sales_user:s3cret@postgres:5432/jewelry?schema=sales',
  DATABASE_POOL_MAX: '20',
  RABBITMQ_URL: 'amqp://jewelry_app:s3cret@rabbitmq:5672',
  JWT_PUBLIC_KEY_PATH: '/run/secrets/jwt-public.pem',
  JWT_ISSUER: 'auth-service',
  JWT_AUDIENCE_BACKOFFICE: 'store-backoffice',
  JWT_AUDIENCE_SHOP: 'store-shop',
};

describe('parseEnv (sales)', () => {
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
        'JWT_AUDIENCE_BACKOFFICE',
        'JWT_AUDIENCE_SHOP',
        'JWT_ISSUER',
        'JWT_PUBLIC_KEY_PATH',
        'PORT',
        'RABBITMQ_URL',
      ]);
    }
  });

  it('từ chối URL không có mật khẩu', () => {
    const result = parseEnv({
      ...valid,
      DATABASE_URL: 'postgresql://sales_user:@postgres:5432/jewelry?schema=sales',
    });
    assert.equal(result.ok, false);
  });

  it('từ chối URL trỏ sai schema', () => {
    const result = parseEnv({
      ...valid,
      DATABASE_URL: 'postgresql://sales_user:s3cret@postgres:5432/jewelry?schema=public',
    });
    assert.equal(result.ok, false);
  });

  it('từ chối PORT không phải số', () => {
    assert.equal(parseEnv({ ...valid, PORT: 'abc' }).ok, false);
  });
});
