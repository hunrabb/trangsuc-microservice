import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyError,
  isDuplicateProcessedEvent,
  PermanentError,
  TransientError,
} from './message-errors.ts';

// Đúng dạng lỗi đo được từ Prisma 7 + @prisma/adapter-pg trên Postgres thật.
const prismaError = (code: string, cause?: object, modelName?: string) =>
  Object.assign(new Error('lỗi'), {
    name: 'PrismaClientKnownRequestError',
    code,
    meta: {
      ...(cause ? { driverAdapterError: { name: 'DriverAdapterError', cause } } : {}),
      ...(modelName ? { modelName } : {}),
    },
  });

describe('classifyError', () => {
  it('lớp lỗi do handler tự ném', () => {
    assert.equal(classifyError(new TransientError('x')), 'TRANSIENT');
    assert.equal(classifyError(new PermanentError('x')), 'PERMANENT');
  });

  it('deadlock và serialization: Prisma báo P2010, phải đọc mã Postgres', () => {
    for (const originalCode of ['40P01', '40001']) {
      const cause = { originalCode, kind: 'TransactionWriteConflict' };
      assert.equal(classifyError(prismaError('P2010', cause)), 'TRANSIENT', originalCode);
    }
  });

  it('mất kết nối DB ở cả ba dạng đo được', () => {
    assert.equal(
      classifyError(prismaError('P2039', { originalCode: '57P01', kind: 'postgres' })),
      'TRANSIENT',
    );
    assert.equal(
      classifyError(prismaError('P2010', { kind: 'DatabaseNotReachable' })),
      'TRANSIENT',
    );
    assert.equal(classifyError(prismaError('P1001')), 'TRANSIENT');
  });

  it('timeout: hết giờ transaction, statement_timeout, lock_timeout, pool', () => {
    assert.equal(classifyError(prismaError('P2028')), 'TRANSIENT');
    assert.equal(classifyError(prismaError('P2024')), 'TRANSIENT');
    for (const originalCode of ['57014', '55P03']) {
      assert.equal(
        classifyError(prismaError('P2010', { originalCode, kind: 'postgres' })),
        'TRANSIENT',
      );
    }
  });

  it('lỗi mạng của Node', () => {
    const error = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    assert.equal(classifyError(error), 'TRANSIENT');
  });

  it('mọi lỗi khác là vĩnh viễn', () => {
    assert.equal(classifyError(new Error('bug')), 'PERMANENT');
    assert.equal(classifyError(new TypeError('x')), 'PERMANENT');
    assert.equal(classifyError('chuỗi'), 'PERMANENT');
    assert.equal(classifyError(null), 'PERMANENT');
    assert.equal(
      classifyError(
        prismaError('P2010', { originalCode: '23503', kind: 'ForeignKeyConstraintViolation' }),
      ),
      'PERMANENT',
    );
    assert.equal(
      classifyError(prismaError('P2002', { kind: 'UniqueConstraintViolation' })),
      'PERMANENT',
    );
  });
});

describe('isDuplicateProcessedEvent', () => {
  const unique = (index: string) => ({
    originalCode: '23505',
    kind: 'UniqueConstraintViolation',
    constraint: { index },
    table: index.replace('_pkey', ''),
  });

  it('đúng khoá ProcessedEvent', () => {
    const error = prismaError('P2002', unique('ProcessedEvent_pkey'), 'ProcessedEvent');
    assert.equal(isDuplicateProcessedEvent(error), true);
  });

  it('P2002 của bảng khác không được coi là đã xử lý', () => {
    assert.equal(
      isDuplicateProcessedEvent(prismaError('P2002', unique('OutboxEvent_pkey'), 'OutboxEvent')),
      false,
    );
  });

  it('unique khác trên cùng bảng, hoặc lỗi khác', () => {
    assert.equal(
      isDuplicateProcessedEvent(prismaError('P2002', unique('Khac_key'), 'ProcessedEvent')),
      false,
    );
    assert.equal(isDuplicateProcessedEvent(new Error('x')), false);
    assert.equal(isDuplicateProcessedEvent(null), false);
  });
});
