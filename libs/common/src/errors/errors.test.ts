import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { errorResponseSchema } from '@jewelry/contracts';
import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  Logger,
  MethodNotAllowedException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.ts';
import { BusinessError } from './business-error.ts';
import { INTERNAL_ERROR_MESSAGE } from './error-mapping.ts';
import { GlobalExceptionFilter } from './global-exception.filter.ts';

const ID = '3f2b8c1e-5a4d-4f6b-9c7e-1d2e3f4a5b6c';

function run(exception: unknown, headersSent = false) {
  let status = 0;
  let body: Record<string, unknown> = {};
  let ended = false;
  const headers: Record<string, string> = {};
  const response = {
    headersSent,
    setHeader: (name: string, value: string) => (headers[name] = value),
    status: (code: number) => {
      status = code;
      return { json: (payload: Record<string, unknown>) => (body = payload) };
    },
    end: () => (ended = true),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { 'x-correlation-id': ID } }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  const logged = mock.method(Logger.prototype, 'error', () => undefined);
  try {
    new GlobalExceptionFilter().catch(exception, host);
  } finally {
    logged.mock.restore();
  }
  return { status, body, headers, ended, logged: logged.mock.calls };
}

describe('GlobalExceptionFilter', () => {
  it('BusinessError: đúng status, mã, details', () => {
    const { status, body } = run(new BusinessError('INVALID_STATE', 'Sai', 409, { id: 1 }));
    assert.equal(status, 409);
    assert.deepEqual(body, {
      code: 'INVALID_STATE',
      message: 'Sai',
      details: { id: 1 },
      correlationId: ID,
    });
  });

  it('lỗi HTTP chuẩn của Nest đổi sang mã tương ứng', () => {
    const cases: [HttpException, number, string][] = [
      [new NotFoundException('Cannot GET /x'), 404, 'NOT_FOUND'],
      [new MethodNotAllowedException(), 405, 'METHOD_NOT_ALLOWED'],
      [new PayloadTooLargeException(), 413, 'PAYLOAD_TOO_LARGE'],
      [new BadRequestException('JSON hỏng'), 400, 'VALIDATION_FAILED'],
      [new ServiceUnavailableException('host nội bộ'), 503, 'SERVICE_UNAVAILABLE'],
    ];
    for (const [exception, expectedStatus, code] of cases) {
      const { status, body, logged } = run(exception);
      assert.equal(status, expectedStatus);
      assert.equal(body.code, code);
      assert.equal(logged.length, 0);
    }
    assert.ok(!JSON.stringify(run(cases[4]![0]).body).includes('host nội bộ'));
  });

  it('lỗi lạ: 500 message chung, không lộ gì, có ghi log kèm Error', () => {
    const error = new Error('password=bi-mat');
    const { status, body, logged } = run(error);
    assert.equal(status, 500);
    assert.deepEqual(body, {
      code: 'INTERNAL_ERROR',
      message: INTERNAL_ERROR_MESSAGE,
      correlationId: ID,
    });
    assert.equal(logged[0]?.arguments[0], error);
  });

  it('lỗi 5xx của Nest và giá trị không phải Error cũng là 500 chung', () => {
    assert.equal(run(new HttpException('chi tiết', 500)).body.message, INTERNAL_ERROR_MESSAGE);
    assert.equal(run('chuỗi lạ').status, 500);
  });

  it('phản hồi luôn có correlationId, kể cả trong header, và khớp schema', () => {
    const { headers, body } = run(new NotFoundException());
    assert.equal(headers['x-correlation-id'], ID);
    assert.equal(errorResponseSchema.safeParse(body).success, true);
  });

  it('đã gửi header thì chỉ kết thúc phản hồi', () => {
    const { status, ended } = run(new Error('x'), true);
    assert.equal(status, 0);
    assert.equal(ended, true);
  });
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(
    z.object({ qty: z.number(), item: z.object({ id: z.uuid() }) }),
  );

  it('trả dữ liệu đã kiểm tra', () => {
    const value = { qty: 1, item: { id: ID } };
    assert.deepEqual(pipe.transform(value), value);
  });

  it('dữ liệu sai: 400 VALIDATION_FAILED, details liệt kê từng trường', () => {
    const { status, body } = (() => {
      try {
        pipe.transform({ qty: 'a', item: { id: 'x' } });
      } catch (error) {
        return run(error);
      }
      throw new Error('phải ném lỗi');
    })();
    assert.equal(status, 400);
    assert.equal(body.code, 'VALIDATION_FAILED');
    const { fields } = body.details as { fields: { field: string }[] };
    assert.deepEqual(fields.map((f) => f.field).sort(), ['item.id', 'qty']);
  });
});
