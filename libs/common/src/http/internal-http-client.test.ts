import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Logger } from '@nestjs/common';
import { BusinessError } from '../errors/business-error.ts';
import { callInternal } from './internal-http-client.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, hit: number) => void;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

const expectError = async (call: Promise<unknown>, status: number, code: string) => {
  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof BusinessError);
    assert.equal(error.httpStatus, status);
    assert.equal(error.code, code);
    return true;
  });
};

describe('callInternal', () => {
  let server: Server;
  let url: string;
  let hits: IncomingMessage[];
  let handler: Handler;

  before(async () => {
    Logger.overrideLogger(false);
    server = createServer((req, res) => {
      hits.push(req);
      handler(req, res, hits.length);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  beforeEach(() => {
    hits = [];
  });

  it('trả body JSON, luôn gửi x-correlation-id, chuyển tiếp Authorization', async () => {
    handler = (_req, res) => json(res, 200, { ok: true });
    const result = await callInternal({ url, authorization: 'Bearer t' });

    assert.deepEqual(result, { ok: true });
    assert.match(String(hits[0]?.headers['x-correlation-id']), /^[0-9a-f-]{36}$/);
    assert.equal(hits[0]?.headers.authorization, 'Bearer t');
  });

  it('204 không có body thì trả undefined', async () => {
    handler = (_req, res) => void res.writeHead(204).end();
    assert.equal(await callInternal({ url }), undefined);
  });

  it('GET: retry 503 rồi thành công', async () => {
    handler = (_req, res, hit) => (hit < 3 ? json(res, 503, {}) : json(res, 200, { lan: hit }));
    assert.deepEqual(await callInternal({ url }), { lan: 3 });
    assert.equal(hits.length, 3);
  });

  it('GET: tối đa 3 lượt rồi trả 503 SERVICE_UNAVAILABLE', async () => {
    handler = (_req, res) => json(res, 502, {});
    await expectError(callInternal({ url }), 503, 'SERVICE_UNAVAILABLE');
    assert.equal(hits.length, 3);
  });

  it('POST mặc định không retry', async () => {
    handler = (_req, res) => json(res, 503, {});
    await expectError(callInternal({ url, method: 'POST', body: {} }), 503, 'SERVICE_UNAVAILABLE');
    assert.equal(hits.length, 1);
  });

  it('POST khai báo idempotent thì được retry', async () => {
    handler = (_req, res, hit) => (hit === 1 ? json(res, 503, {}) : json(res, 200, { ok: 1 }));
    const result = await callInternal({ url, method: 'POST', body: {}, idempotent: true });
    assert.deepEqual(result, { ok: 1 });
    assert.equal(hits.length, 2);
  });

  it('500 không phải lỗi tạm thời: không retry, vẫn là 503', async () => {
    handler = (_req, res) => json(res, 500, {});
    await expectError(callInternal({ url }), 503, 'SERVICE_UNAVAILABLE');
    assert.equal(hits.length, 1);
  });

  it('4xx có ErrorResponse: ném lại cùng mã, cùng status, không retry', async () => {
    handler = (_req, res) =>
      json(res, 409, {
        code: 'INVALID_STATE',
        message: 'Sai',
        details: { a: 1 },
        correlationId: 'c',
      });
    await assert.rejects(callInternal({ url }), (error: unknown) => {
      assert.ok(error instanceof BusinessError);
      assert.deepEqual(
        [error.code, error.httpStatus, error.message, error.details],
        ['INVALID_STATE', 409, 'Sai', { a: 1 }],
      );
      return true;
    });
    assert.equal(hits.length, 1);
  });

  it('4xx không có ErrorResponse: suy mã theo status', async () => {
    handler = (_req, res) => void res.writeHead(404).end('khong phai json');
    await expectError(callInternal({ url }), 404, 'NOT_FOUND');
  });

  it('2xx không phải JSON: 503, không retry', async () => {
    handler = (_req, res) => void res.writeHead(200).end('<html>');
    await expectError(callInternal({ url }), 503, 'SERVICE_UNAVAILABLE');
    assert.equal(hits.length, 1);
  });

  it('timeout đúng theo cấu hình từng lần gọi, có retry với GET', async () => {
    handler = () => undefined;
    const started = Date.now();
    await expectError(callInternal({ url, timeoutMs: 50 }), 503, 'SERVICE_UNAVAILABLE');
    const elapsed = Date.now() - started;

    assert.equal(hits.length, 3);
    assert.ok(elapsed >= 150 + 400 - 20, `quá nhanh: ${elapsed} ms`);
    assert.ok(elapsed < 2000, `quá chậm: ${elapsed} ms`);
  });

  it('POST bị timeout không retry', async () => {
    handler = () => undefined;
    await expectError(
      callInternal({ url, method: 'POST', body: {}, timeoutMs: 50 }),
      503,
      'SERVICE_UNAVAILABLE',
    );
    assert.equal(hits.length, 1);
  });

  it('không kết nối được: 503', async () => {
    await expectError(
      callInternal({ url: 'http://127.0.0.1:1/x', timeoutMs: 100 }),
      503,
      'SERVICE_UNAVAILABLE',
    );
  });
});
