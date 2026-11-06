import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { z } from 'zod';
import { httpUrlField, nodeEnvField, portField, postgresUrlField } from './env-fields.ts';
import { parseEnv, validateEnv } from './parse-env.ts';

const schema = z.object({
  NODE_ENV: nodeEnvField,
  PORT: portField,
  UPSTREAM_URL: httpUrlField,
  DATABASE_URL: postgresUrlField('inventory'),
});

const valid = {
  PORT: '3000',
  UPSTREAM_URL: 'http://inventory:3000',
  DATABASE_URL: 'postgresql://u:p@db:5432/jewelry?schema=inventory',
};

describe('parseEnv', () => {
  it('trả về giá trị đã chuyển kiểu và điền mặc định', () => {
    const result = parseEnv(schema, valid);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.env.PORT, 3000);
      assert.equal(result.env.NODE_ENV, 'development');
    }
  });

  it('báo đúng tên mọi biến bị thiếu, mỗi biến một lần', () => {
    const result = parseEnv(schema, {});
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.problems.map((p) => p.variable).sort(), [
        'DATABASE_URL',
        'PORT',
        'UPSTREAM_URL',
      ]);
      assert.equal(result.problems[0]?.problem, 'thiếu biến');
    }
  });

  it('từ chối PORT, URL và schema DB sai', () => {
    assert.equal(parseEnv(schema, { ...valid, PORT: 'abc' }).ok, false);
    assert.equal(parseEnv(schema, { ...valid, PORT: '70000' }).ok, false);
    assert.equal(parseEnv(schema, { ...valid, UPSTREAM_URL: 'ftp://x' }).ok, false);
    assert.equal(
      parseEnv(schema, { ...valid, DATABASE_URL: 'postgresql://u:@db/jewelry?schema=inventory' })
        .ok,
      false,
    );
    assert.equal(
      parseEnv(schema, { ...valid, DATABASE_URL: 'postgresql://u:p@db/jewelry?schema=sales' }).ok,
      false,
    );
  });
});

describe('validateEnv', () => {
  it('trả về cấu hình khi hợp lệ', () => {
    assert.equal(validateEnv(schema, valid, 'test').PORT, 3000);
  });

  it('thoát mã 1 khi thiếu biến', () => {
    const exit = mock.method(process, 'exit', (code?: number) => {
      throw new Error(`exit ${code}`);
    });
    try {
      assert.throws(() => validateEnv(schema, {}, 'test'), /exit 1/);
    } finally {
      exit.mock.restore();
    }
  });
});
