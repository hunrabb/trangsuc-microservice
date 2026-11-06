import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { BodyTooLargeError, readBody } from './read-body.ts';

describe('readBody', () => {
  it('giữ nguyên từng byte', async () => {
    const bytes = [Buffer.from([0, 255]), Buffer.from('ệ')];
    assert.deepEqual(await readBody(Readable.from(bytes), 100), Buffer.concat(bytes));
  });

  it('đúng giới hạn thì nhận, vượt một byte thì từ chối', async () => {
    assert.equal((await readBody(Readable.from([Buffer.alloc(10)]), 10)).length, 10);
    await assert.rejects(readBody(Readable.from([Buffer.alloc(11)]), 10), BodyTooLargeError);
  });
});
