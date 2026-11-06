import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postgresCheck, runReadinessChecks, type ReadinessCheck } from './readiness.ts';

const up: ReadinessCheck = { name: 'up', check: async () => 1 };
const down: ReadinessCheck = {
  name: 'down',
  check: async () => {
    throw new Error('hỏng');
  },
};
const ignore = () => undefined;

describe('runReadinessChecks', () => {
  it('sẵn sàng khi không có kiểm tra nào', async () => {
    assert.deepEqual(await runReadinessChecks([], ignore), { ready: true, checks: {} });
  });

  it('một kiểm tra hỏng thì chưa sẵn sàng, kiểm tra khác vẫn được báo', async () => {
    const failures: string[] = [];
    const report = await runReadinessChecks([up, down], (name) => failures.push(name));
    assert.deepEqual(report, { ready: false, checks: { up: 'up', down: 'down' } });
    assert.deepEqual(failures, ['down']);
  });

  it('kiểm tra bị treo được tính là hỏng khi hết giờ', async () => {
    const hung: ReadinessCheck = { name: 'hung', check: () => new Promise(() => undefined) };
    const report = await runReadinessChecks([hung], ignore, 10);
    assert.deepEqual(report, { ready: false, checks: { hung: 'down' } });
  });
});

describe('postgresCheck', () => {
  it('chạy SELECT 1 qua client được truyền vào', async () => {
    const queries: string[] = [];
    const check = postgresCheck({
      $queryRawUnsafe: async (query) => {
        queries.push(query);
        return [{ '?column?': 1 }];
      },
    });
    await check.check();
    assert.equal(check.name, 'postgres');
    assert.deepEqual(queries, ['SELECT 1']);
  });
});
