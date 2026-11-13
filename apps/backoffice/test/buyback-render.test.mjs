import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter } from 'react-router';
const require = createRequire(import.meta.url);
const ts = require('typescript');
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2023,
        },
      }).outputText,
    };
  },
});
const { BuybackListTable, BuybackResults } = await import('../src/buybacks/list-page.tsx');
const { IntakeForm } = await import('../src/buybacks/intake-form.tsx');
const { QuoteView } = await import('../src/buybacks/quote-view.tsx');
const { emptyIntake } = await import('../src/buybacks/model.ts');
const { ErrorAlert } = await import('../src/components/error-alert.tsx');
const { SettlementSummary, SettlementHistory, ApprovedQuote } =
  await import('../src/buybacks/settlement-panel.tsx');
const { ApiError } = await import('../src/api/api-error.ts');
const render = (component) =>
  renderToStaticMarkup(
    React.createElement(
      MantineProvider,
      { env: 'test' },
      React.createElement(MemoryRouter, null, component),
    ),
  );
const id = '11111111-1111-4111-8111-111111111111';

test('danh sách render dữ liệu thật theo contract và badge trạng thái', () => {
  const html = render(
    React.createElement(BuybackListTable, {
      page: {
        page: 1,
        pageSize: 20,
        total: 1,
        items: [
          {
            id,
            code: 'BB-TEST',
            branchId: id,
            createdBy: id,
            customerId: null,
            customerName: 'Khách thử',
            status: 'APPROVED',
            version: 4,
            receivedAt: '2026-11-10T01:00:00.000Z',
            updatedAt: '2026-11-10T01:00:00.000Z',
            submittedAt: null,
            cancelledAt: null,
            itemCount: 2,
          },
        ],
      },
    }),
  );
  for (const value of ['BB-TEST', 'Khách thử', 'Đã duyệt giá', 'Xem chi tiết', '2'])
    assert.ok(html.includes(value), value);
  assert.ok(html.includes(`/thu-mua/${id}`));
});

test('form tiếp nhận render hai món và lỗi version có nút tải lại', () => {
  const fields = emptyIntake();
  fields.items.push({ ...fields.items[0], description: 'Dây chuyền' });
  const form = render(
    React.createElement(IntakeForm, {
      initial: fields,
      submitLabel: 'Tạo phiếu',
      busy: false,
      error: null,
      onSubmit: async () => {},
    }),
  );
  for (const value of ['Món 1', 'Món 2', 'Dây chuyền', 'Tạo phiếu'])
    assert.ok(form.includes(value), value);
  const alert = render(
    React.createElement(ErrorAlert, {
      error: new ApiError({ status: 409, code: 'VERSION_CONFLICT', message: 'stale' }),
      onReload: () => {},
    }),
  );
  assert.ok(alert.includes('Tải lại'));
});

test('danh sách có loading skeleton, empty state và lỗi truy cập rõ ràng', () => {
  const props = {
    branchId: id,
    data: undefined,
    pending: true,
    error: null,
    page: 1,
    onPageChange: () => {},
    onReload: () => {},
  };
  const loading = render(React.createElement(BuybackResults, props));
  assert.ok(loading.includes('mantine-Skeleton'));
  const empty = render(
    React.createElement(BuybackResults, {
      ...props,
      pending: false,
      data: { items: [], total: 0, page: 1, pageSize: 20 },
    }),
  );
  assert.ok(empty.includes('Chưa có phiếu thu mua phù hợp'));
  const forbidden = render(
    React.createElement(BuybackResults, {
      ...props,
      pending: false,
      error: new ApiError({ status: 403, code: 'FORBIDDEN', message: 'no' }),
    }),
  );
  assert.ok(forbidden.includes('không có quyền'));
});

test('báo giá render số tiền và nguồn giá backend; maker-checker vô hiệu hóa nút duyệt', () => {
  const quote = {
    id,
    status: 'QUOTED',
    total: '1234000.00',
    quotedBy: id,
    quotedAt: '2026-11-10T01:00:00.000Z',
    sourceVersion: 4,
    rejectionReason: null,
    lines: [
      {
        itemId: id,
        acceptedWeight: '1.0000',
        metalCode: 'AU750',
        unitPrice: '1500000.00',
        priceId: id,
        effectiveFrom: '2026-11-10T00:00:00.000Z',
        capturedAt: '2026-11-10T01:00:00.000Z',
        policyVersion: 2,
        purityPerMille: '750.0000',
        deductionVndPerItem: '266000.00',
        amount: '1234000.00',
      },
    ],
  };
  const html = render(
    React.createElement(QuoteView, {
      detail: { items: [{ id, description: 'Nhẫn cũ' }] },
      quote,
      canDecide: true,
      approvalReason: 'Người duyệt phải khác người lập giá',
      onApprove: () => {},
      onReject: () => {},
    }),
  );
  for (const value of [
    '1.234.000',
    'Nhẫn cũ',
    'Inventory',
    'AU750',
    'Policy v2',
    'Người duyệt phải khác',
  ])
    assert.ok(html.includes(value), value);
  assert.ok(/<button[^>]*disabled[^>]*>[\s\S]*?Duyệt báo giá/.test(html));
  assert.ok(html.includes('Từ chối'));
});

test('settlement phân biệt đã ghi chứng từ, hoàn tất và cần đối soát; hiển thị lịch sử backend cung cấp', () => {
  const row = {
    id,
    kind: 'DIRECT',
    status: 'PAYMENT_RECORDED',
    version: 2,
    branchId: id,
    approvedAmount: '1234000.00',
    amountDue: '1234000.00',
    saleAmount: null,
    difference: null,
    direction: 'STORE_PAYS',
    method: 'CASH',
    tagCode: null,
    reservationExpiresAt: null,
    paymentReference: 'DOC-01',
    paymentEvidence: 'Đã nhận giấy tờ',
    paymentRecordedBy: id,
    paymentConfirmedBy: null,
    paymentConfirmedAt: null,
    confirmationNote: null,
    orderId: null,
    failureCode: null,
    createdBy: id,
    createdAt: '2026-11-10T01:00:00.000Z',
    updatedAt: '2026-11-10T02:00:00.000Z',
  };
  const html = render(React.createElement(SettlementSummary, { row }));
  assert.ok(html.includes('Đã ghi chứng từ, chờ xác nhận'));
  assert.ok(html.includes('1.234.000'));
  assert.ok(html.includes('DOC-01'));
  const history = render(React.createElement(SettlementHistory, { row }));
  assert.ok(history.includes('Không có thời điểm riêng trong API'));
  assert.ok(history.includes('audit settlement'));
  const settled = render(
    React.createElement(SettlementSummary, { row: { ...row, status: 'SETTLED' } }),
  );
  assert.ok(settled.includes('Đã hoàn tất'));
  const reconciliation = render(
    React.createElement(SettlementSummary, {
      row: { ...row, status: 'RECONCILIATION_REQUIRED', failureCode: 'INVENTORY_UNAVAILABLE' },
    }),
  );
  assert.ok(reconciliation.includes('Cần đối soát'));
  assert.ok(reconciliation.includes('INVENTORY_UNAVAILABLE'));
});

test('exchange hiển thị đúng chênh lệch dương, âm và bằng không do backend trả về', () => {
  const base = {
    id,
    kind: 'EXCHANGE',
    status: 'AWAITING_PAYMENT',
    version: 2,
    approvedAmount: '1000000.00',
    saleAmount: '1500000.00',
    difference: '500000.00',
    direction: 'CUSTOMER_PAYS',
    amountDue: '500000.00',
    tagCode: 'NEW-01',
    method: 'BANK_TRANSFER',
    createdBy: id,
    createdAt: '2026-11-10T01:00:00.000Z',
    updatedAt: '2026-11-10T01:00:00.000Z',
  };
  const positive = render(React.createElement(SettlementSummary, { row: base }));
  assert.ok(positive.includes('Khách trả thêm'));
  assert.ok(positive.includes('500.000'));
  const negative = render(
    React.createElement(SettlementSummary, {
      row: { ...base, saleAmount: '500000.00', difference: '-500000.00', direction: 'STORE_PAYS' },
    }),
  );
  assert.ok(negative.includes('Cửa hàng chi trả'));
  assert.ok(negative.includes('-500.000'));
  const zero = render(
    React.createElement(SettlementSummary, {
      row: {
        ...base,
        saleAmount: '1000000.00',
        difference: '0.00',
        amountDue: '0.00',
        direction: 'NONE',
      },
    }),
  );
  assert.ok(zero.includes('Không thu/chi chênh lệch'));
  assert.ok(zero.includes('0 ₫'));
  const quote = render(
    React.createElement(ApprovedQuote, {
      quote: { total: '1000000.00', decidedBy: id, decidedAt: '2026-11-10T01:00:00.000Z' },
    }),
  );
  assert.ok(quote.includes('Báo giá đã duyệt'));
});

test('lỗi quyền, version, chứng từ trùng và timeout hiển thị hướng xử lý', () => {
  const cases = [
    [403, 'FORBIDDEN', 'không có quyền'],
    [409, 'VERSION_CONFLICT', 'Tải lại'],
    [409, 'PAYMENT_REFERENCE_CONFLICT', 'Mã chứng từ đã được dùng'],
    [0, 'NETWORK_ERROR', 'Không kết nối được'],
  ];
  for (const [status, code, expected] of cases) {
    const html = render(
      React.createElement(ErrorAlert, {
        error: new ApiError({ status, code, message: 'server' }),
        onReload: () => {},
      }),
    );
    assert.ok(html.includes(expected), code);
  }
});
