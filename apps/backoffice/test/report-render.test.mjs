import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
const require = createRequire(import.meta.url);
const ts = require('typescript');
// Node strip-types không đọc TSX. Chỉ transpile JSX cho test SSR, không thay component.
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
const { ReportPanels } = await import('../src/pages/report-panels.tsx');
const { ApiError } = await import('../src/api/api-error.ts');
const id = '11111111-1111-4111-8111-111111111111';
const state = (data) => ({ data, loading: false, retry: () => undefined });
function props() {
  return {
    roles: [{ role: 'MANAGER', branchId: id }],
    daily: state({
      timezone: 'Asia/Ho_Chi_Minh',
      rows: [
        {
          date: '2026-11-09',
          branchId: id,
          channel: 'POS',
          orderCount: 1,
          revenue: '100000.00',
          cogs: '80000.00',
          grossProfit: '20000.00',
        },
      ],
    }),
    top: state([
      { variantId: id, productName: 'Nhẫn thử nghiệm', quantity: 1, revenue: '100000.00' },
    ]),
    stock: state({
      from: '2026-11-01',
      to: '2026-11-09',
      coverage: 'REQUESTED_BRANCH',
      warehouses: [],
    }),
    branchLabel: () => 'Chi nhánh A',
    canExport: true,
    downloading: null,
    onDownload: () => undefined,
  };
}
const render = (values) =>
  renderToStaticMarkup(
    React.createElement(
      MantineProvider,
      { env: 'test' },
      React.createElement(ReportPanels, values),
    ),
  );

test('render báo cáo thật: summary, ngày Việt Nam, top sản phẩm và ba nút Excel', () => {
  const html = render(props());
  for (const text of [
    'Tổng doanh thu',
    '100.000',
    '20.000',
    '09/11/2026',
    'Chi nhánh A',
    'Nhẫn thử nghiệm',
    'Nhập–xuất–tồn',
  ])
    assert.ok(html.includes(text), text);
  assert.equal((html.match(/Tải Excel/g) ?? []).length, 3);
});
test('loading/error/empty render rõ, không để số liệu cũ hiện khi truy vấn lỗi', () => {
  const values = props();
  values.daily.loading = true;
  values.top.error = new ApiError({ status: 503, code: 'SERVICE_UNAVAILABLE', message: 'fixture' });
  values.stock = state({ warehouses: [], coverage: 'REQUESTED_BRANCH' });
  const html = render(values);
  assert.ok(html.includes('Đang tải doanh thu'));
  assert.ok(html.includes('Hệ thống đang bận'));
  assert.ok(html.includes('Chưa có dữ liệu nhập–xuất–tồn'));
  assert.equal(html.includes('Nhẫn thử nghiệm'), false);
  assert.equal(html.includes('Tổng doanh thu'), false);
});
test('snapshot incomplete và COGS null có cảnh báo, bỏ qua hàng tồn không đầy đủ', () => {
  const values = props();
  values.daily.data.rows[0].cogs = null;
  values.daily.data.rows[0].grossProfit = null;
  values.stock = state({
    coverage: 'OBSERVED_WAREHOUSES_ONLY',
    warehouses: [
      {
        branchId: id,
        warehouseId: id,
        complete: false,
        reason: 'MISSING_SNAPSHOT',
        missingDates: ['2026-11-08'],
        rows: [{ sku: 'MUST-NOT-RENDER' }],
      },
    ],
  });
  const html = render(values);
  for (const text of [
    'Chưa đầy đủ giá vốn',
    'Dữ liệu tồn kho chưa đầy đủ',
    'Thiếu bản chốt kho',
    '08/11/2026',
    'Chưa xác nhận đủ dữ liệu mọi chi nhánh',
  ])
    assert.ok(html.includes(text), text);
  assert.equal(html.includes('MUST-NOT-RENDER'), false);
});
test('STAFF không được dựng bảng; export bị disable khi ngoài giới hạn hoặc đang tải', () => {
  const denied = props();
  denied.roles = [{ role: 'STAFF', branchId: id }];
  assert.ok(render(denied).includes('Bạn không có quyền xem báo cáo'));
  assert.equal(render(denied).includes('Nhẫn thử nghiệm'), false);
  const restricted = props();
  restricted.canExport = false;
  assert.equal((render(restricted).match(/ disabled=""/g) ?? []).length, 3);
  const downloading = props();
  downloading.downloading = 'daily';
  assert.ok(render(downloading).includes('data-loading'));
});

test('tồn kho đầy đủ render chiếc/chỉ/vốn và tách nhập hàng, trả kho, xuất bán', () => {
  const values = props();
  const amount = { pieces: 2, chi: '1.2500', costValue: '80000.00' };
  values.stock = state({
    coverage: 'REQUESTED_BRANCH',
    warehouses: [
      {
        branchId: id,
        warehouseId: id,
        complete: true,
        reason: null,
        missingDates: [],
        rows: [
          {
            variantId: id,
            sku: 'TEST-18K',
            metalId: id,
            metalCode: '18K',
            metalKind: 'GOLD',
            opening: amount,
            received: amount,
            released: amount,
            sold: amount,
            closing: amount,
          },
        ],
      },
    ],
  });
  const html = render(values);
  for (const text of [
    'Đầy đủ',
    'TEST-18K',
    'Vàng',
    '18K',
    '2 chiếc',
    '1,25 chỉ',
    '80.000',
    'Nhập hàng',
    'Trả kho',
    'Xuất bán',
  ])
    assert.ok(html.includes(text), text);
  assert.equal(html.includes('Dữ liệu tồn kho chưa đầy đủ'), false);
});
