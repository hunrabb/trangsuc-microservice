import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DeadLetterMessage } from '@jewelry/contracts';
import { canReplayDeadLetter, dlqListState } from './dlq-view.ts';

const message = (replayable: boolean): DeadLetterMessage => ({
  id: '9f6306d7-ecfd-4777-8c35-27deab2372a1',
  sourceQueue: 'report.events',
  sourceService: 'report',
  routingKey: 'system.test',
  deadLetterQueue: 'report.events.dlq',
  eventType: 'system.test',
  eventId: 'b833eebe-eb03-4bfa-b7cc-913ac4380d67',
  correlationId: '79426529-b31c-49e4-92a3-7098501df40f',
  failureKind: 'PERMANENT',
  failureReason: 'Lỗi xử lý sự kiện',
  retryCount: 0,
  failedAt: '2026-11-09T00:00:00.000Z',
  replayCount: 0,
  replayable,
  attempts: [],
});

describe('trạng thái giao diện DLQ', () => {
  it('phân biệt loading, error, empty và danh sách có dữ liệu', () => {
    assert.equal(dlqListState({ loading: true, error: false, itemCount: 0 }), 'LOADING');
    assert.equal(dlqListState({ loading: false, error: true, itemCount: 0 }), 'ERROR');
    assert.equal(dlqListState({ loading: false, error: false, itemCount: 0 }), 'EMPTY');
    assert.equal(dlqListState({ loading: false, error: false, itemCount: 1 }), 'READY');
  });

  it('chỉ ADMIN thấy thao tác replay cho thư đủ điều kiện', () => {
    assert.equal(canReplayDeadLetter(false, message(true)), false);
    assert.equal(canReplayDeadLetter(true, message(false)), false);
    assert.equal(canReplayDeadLetter(true, message(true)), true);
  });
});
