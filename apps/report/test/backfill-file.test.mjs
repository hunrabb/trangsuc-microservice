import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { importBackfillFile } = require('../dist/orders/backfill-file.js');

async function fixture(context, content = '{"id":1}\n{"id":2}\n{"id":3}\n') {
  const directory = await mkdtemp(join(tmpdir(), 'backfill-file-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    input: join(directory, 'input.jsonl'),
    audit: join(directory, 'audit.jsonl'),
    checkpoint: join(directory, 'cursor.json'),
  };
  await writeFile(options.input, content);
  return { directory, options };
}

test('file thật: batch bounded, default dry-run, resume không xử lý lại và audit/checkpoint 0600', async (context) => {
  const { options } = await fixture(context);
  const calls = [];
  async function work(raw, apply) {
    assert.equal(apply, false);
    calls.push(raw.id);
    return { status: 'NEEDED', missingCost: true };
  }
  const first = await importBackfillFile({ ...options, batchSize: 2 }, work);
  assert.equal(first.mode, 'DRY_RUN');
  assert.equal(first.nextLine, 2);
  assert.equal(first.processed, 2);
  assert.equal(first.incompleteCost, 2);
  const second = await importBackfillFile({ ...options, batchSize: 2 }, work);
  assert.equal(second.nextLine, 3);
  assert.equal(second.processed, 1);
  assert.equal((await importBackfillFile(options, work)).processed, 0);
  assert.deepEqual(calls, [1, 2, 3]);
  const audit = (await readFile(options.audit, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    audit.map((line) => line.line),
    [1, 2, 3],
  );
  assert.ok(audit.every((line) => line.fileHash === first.fileHash));
  assert.equal((await stat(options.audit)).mode & 0o777, 0o600);
  assert.equal((await stat(options.checkpoint)).mode & 0o777, 0o600);
});

test('lỗi hạ tầng giữ cursor trước dòng lỗi, lần sau thử lại đúng dòng', async (context) => {
  const { options } = await fixture(context);
  await assert.rejects(
    () =>
      importBackfillFile({ ...options, apply: true }, async (raw) => {
        if (raw.id === 2)
          throw Object.assign(new Error('fixture network outage'), { code: 'ECONNREFUSED' });
        return { status: 'CREATED' };
      }),
    /fixture network outage/,
  );
  assert.equal(JSON.parse(await readFile(options.checkpoint, 'utf8')).line, 1);
  const resumed = [];
  const result = await importBackfillFile({ ...options, apply: true }, async (raw) => {
    resumed.push(raw.id);
    return { status: 'CREATED' };
  });
  assert.deepEqual(resumed, [2, 3]);
  assert.equal(result.nextLine, 3);
});

test('lỗi ghi checkpoint sau callback commit: replay lại dòng, không lặp tác động business', async (context) => {
  const { options, directory } = await fixture(context, '{"id":1}\n');
  const nested = { ...options, apply: true, checkpoint: join(directory, 'missing', 'cursor.json') };
  const committed = new Set();
  async function work(raw) {
    const status = committed.has(raw.id) ? 'EXISTS' : 'CREATED';
    committed.add(raw.id);
    return { status };
  }
  await assert.rejects(
    () => importBackfillFile(nested, work),
    (error) => error.code === 'ENOENT',
  );
  assert.equal(committed.size, 1);
  await mkdir(join(directory, 'missing'));
  const result = await importBackfillFile(nested, work);
  assert.deepEqual(result.counts, { EXISTS: 1 });
  assert.equal(committed.size, 1);
  assert.equal(result.nextLine, 1);
});

test('từ chối đổi mode/hash hoặc dùng chung file; input lỗi được audit và tiếp dòng sau', async (context) => {
  const { options } = await fixture(context, 'invalid JSON\n{"id":2}\n');
  let calls = 0;
  const work = async () => {
    calls++;
    return { status: 'NEEDED' };
  };
  const result = await importBackfillFile(options, work);
  assert.deepEqual(result.counts, { INVALID_OR_CONFLICT: 1, NEEDED: 1 });
  assert.equal(calls, 1);
  await assert.rejects(
    () => importBackfillFile({ ...options, apply: true }, work),
    /Checkpoint không khớp/,
  );
  await assert.rejects(
    () => importBackfillFile({ ...options, audit: options.input }, work),
    /ba file khác nhau/,
  );
  await assert.rejects(() => importBackfillFile({ ...options, batchSize: 501 }, work));
  await writeFile(options.input, '{"id":9}\n');
  await assert.rejects(() => importBackfillFile(options, work), /Checkpoint không khớp/);
  assert.equal(calls, 1);
});
