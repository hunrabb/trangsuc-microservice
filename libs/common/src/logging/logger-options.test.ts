import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { pino, type LoggerOptions } from 'pino';
import { buildLoggerOptions } from './logger-options.ts';

function capture(): { logger: pino.Logger; line: () => Record<string, unknown> } {
  let output = '';
  const sink = new Writable({
    write(chunk, _encoding, done) {
      output += String(chunk);
      done();
    },
  });
  const options = buildLoggerOptions('test-service', () => undefined) as LoggerOptions;
  return { logger: pino(options, sink), line: () => JSON.parse(output) };
}

describe('buildLoggerOptions', () => {
  it('mỗi dòng có service, level dạng chữ và khoá correlationId', () => {
    const { logger, line } = capture();
    logger.info('xin chào');
    const entry = line();
    assert.equal(entry.service, 'test-service');
    assert.equal(entry.level, 'info');
    assert.equal(entry.correlationId, null);
  });

  it('không ghi Authorization, Cookie, Set-Cookie', () => {
    const { logger, line } = capture();
    logger.info({
      req: { headers: { authorization: 'Bearer bi-mat', cookie: 'a=bi-mat', accept: '*/*' } },
      res: { headers: { 'set-cookie': 'a=bi-mat', etag: 'x' } },
    });
    const entry = line();
    assert.deepEqual(entry.req, { headers: { accept: '*/*' } });
    assert.deepEqual(entry.res, { headers: { etag: 'x' } });
  });
});
