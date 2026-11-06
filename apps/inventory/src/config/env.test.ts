import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEnv as parse } from '@jewelry/common';
import { envSchema } from './env.ts';

const parseEnv = (raw: Record<string, unknown>) => parse(envSchema, raw);

const valid = {
  PORT: '3000',
  DATABASE_URL: 'postgresql://inventory_user:s3cret@postgres:5432/jewelry?schema=inventory',
  RABBITMQ_URL: 'amqp://jewelry_app:s3cret@rabbitmq:5672',
  JWT_PUBLIC_KEYS_DIR: '/run/secrets/jwt-public',
  JWT_ISSUER: 'auth-service',
  JWT_AUDIENCE: 'store-system',
};

describe('parseEnv (inventory)', () => {
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
        'JWT_AUDIENCE',
        'JWT_ISSUER',
        'JWT_PUBLIC_KEYS_DIR',
        'PORT',
        'RABBITMQ_URL',
      ]);
    }
  });

  it('từ chối URL không có mật khẩu', () => {
    const result = parseEnv({
      ...valid,
      DATABASE_URL: 'postgresql://inventory_user:@postgres:5432/jewelry?schema=inventory',
    });
    assert.equal(result.ok, false);
  });

  it('từ chối URL trỏ sai schema', () => {
    const result = parseEnv({
      ...valid,
      DATABASE_URL: 'postgresql://inventory_user:s3cret@postgres:5432/jewelry?schema=public',
    });
    assert.equal(result.ok, false);
  });

  it('từ chối PORT không phải số', () => {
    assert.equal(parseEnv({ ...valid, PORT: 'abc' }).ok, false);
  });
});
