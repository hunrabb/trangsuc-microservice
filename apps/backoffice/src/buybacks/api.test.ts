import assert from 'node:assert/strict';
import { it } from 'node:test';
import { api } from '../api/instance.ts';
import { buybackApi } from './api.ts';

const branchId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const calls: { path: string; init: RequestInit }[] = [];
const globalWithWindow = globalThis as unknown as { window: { fetch: typeof fetch } };
globalWithWindow.window = {
  fetch: async (input, init) => {
    calls.push({ path: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 20 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
};
api.setSession({ accessToken: 'test', expiresIn: 3600 } as Parameters<typeof api.setSession>[0]);

it('danh sách chỉ gửi bộ lọc backend hỗ trợ và gắn branch vào URL', async () => {
  calls.length = 0;
  await buybackApi.list(branchId, {
    page: 1,
    pageSize: 20,
    status: 'APPRAISED',
    from: '2026-11-01T00:00:00.000Z',
  });
  const url = new URL(calls[0]!.path, 'http://localhost');
  assert.equal(url.pathname, `/api/admin/sales/branches/${branchId}/buybacks`);
  assert.equal(url.searchParams.get('status'), 'APPRAISED');
  assert.equal(url.searchParams.get('from'), '2026-11-01T00:00:00.000Z');
  assert.equal(url.searchParams.has('search'), false);
});

it('create/appraise/quote/decision dùng đúng đường Gateway, method, version và Idempotency-Key', async () => {
  calls.length = 0;
  const key = 'same-request-key';
  await buybackApi.create(
    branchId,
    { customer: { name: 'A', phone: '0912345678' }, notes: null, items: [] },
    key,
  );
  await buybackApi.appraise(
    branchId,
    id,
    id,
    {
      version: 3,
      measuredWeight: '1',
      acceptedWeight: '1',
      metalId: id,
      metalKind: 'GOLD',
      purityPerMille: '750',
      condition: 'Cũ',
      notes: null,
    },
    key,
  );
  await buybackApi.quote(
    branchId,
    id,
    { version: 4, items: [{ itemId: id, policyId: id, policyVersion: 2 }] },
    key,
  );
  await buybackApi.decide(branchId, id, id, { version: 5, reason: 'Không phù hợp' }, false, key);
  await buybackApi.decide(branchId, id, id, { version: 6 }, true, key);
  assert.deepEqual(
    calls.map(({ init }) => (init.headers as Record<string, string>)['idempotency-key']),
    [key, key, key, key, key],
  );
  assert.deepEqual(
    calls.map(({ init }) => init.method),
    ['POST', 'PUT', 'POST', 'POST', 'POST'],
  );
  assert.ok(calls[1]!.path.endsWith(`/buybacks/${id}/items/${id}/appraisal`));
  assert.ok(calls[2]!.path.endsWith(`/buybacks/${id}/quotes`));
  assert.ok(calls[3]!.path.endsWith(`/buybacks/${id}/quotes/${id}/reject`));
  assert.ok(calls[4]!.path.endsWith(`/buybacks/${id}/quotes/${id}/approve`));
  assert.equal(JSON.parse(String(calls[3]!.init.body)).version, 5);
  api.clearSession();
});

it('settlement/exchange ghi chứng từ và xác nhận đi đúng endpoint, body và key', async () => {
  calls.length = 0;
  const key = 'settlement-same-key';
  await buybackApi.settlement(branchId, id);
  await buybackApi.createSettlement(branchId, id, { version: 7, method: 'CASH' }, key);
  await buybackApi.createExchange(
    branchId,
    id,
    { version: 7, method: 'BANK_TRANSFER', tagCode: 'NEW-01' },
    key,
  );
  await buybackApi.recordPayment(
    branchId,
    id,
    id,
    { version: 1, reference: 'DOC-01', evidence: 'Đã nhận chứng từ giấy' },
    key,
  );
  await buybackApi.confirmPayment(
    branchId,
    id,
    id,
    { version: 2, verificationReference: 'VERIFY-01', note: 'Đã kiểm tra và bàn giao' },
    key,
  );
  await buybackApi.cancelSettlement(
    branchId,
    id,
    id,
    { version: 1, reason: 'Khách không tiếp tục' },
    key,
  );
  assert.deepEqual(
    calls.map(({ init }) => init.method),
    ['GET', 'POST', 'POST', 'POST', 'POST', 'POST'],
  );
  assert.deepEqual(
    calls.map(({ path }) => new URL(path, 'http://localhost').pathname),
    [
      `/api/admin/sales/branches/${branchId}/buybacks/${id}/settlements`,
      `/api/admin/sales/branches/${branchId}/buybacks/${id}/settlements`,
      `/api/admin/sales/branches/${branchId}/buybacks/${id}/exchanges`,
      `/api/admin/sales/branches/${branchId}/buybacks/${id}/settlements/${id}/payment`,
      `/api/admin/sales/branches/${branchId}/buybacks/${id}/settlements/${id}/confirm`,
      `/api/admin/sales/branches/${branchId}/buybacks/${id}/settlements/${id}/cancel`,
    ],
  );
  assert.deepEqual(
    calls.slice(1).map(({ init }) => (init.headers as Record<string, string>)['idempotency-key']),
    [key, key, key, key, key],
  );
  assert.equal(JSON.parse(String(calls[2]!.init.body)).tagCode, 'NEW-01');
  assert.equal(JSON.parse(String(calls[4]!.init.body)).version, 2);
  api.clearSession();
});
