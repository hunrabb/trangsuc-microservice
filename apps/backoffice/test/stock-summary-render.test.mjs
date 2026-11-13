import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
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
const { StockSummaryTable } = await import('../src/pages/stock-summary-table.tsx');
const row = {
  branchId: 'branch',
  variantId: 'variant',
  branchName: 'Chi nhánh A',
  productName: 'Nhẫn hoa',
  variantName: '18K',
  sku: 'NH18',
  metalName: 'Vàng',
  total: 10,
  available: 6,
  reserved: 2,
  sold: 1,
  pendingMelt: 1,
  other: 0,
};
test('summary renders actual server counts, variant and branch', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      MantineProvider,
      {},
      React.createElement(StockSummaryTable, { rows: [row], onSelectVariant() {} }),
    ),
  );
  for (const value of [
    'Nhẫn hoa',
    'NH18',
    'Chi nhánh A',
    'Khả dụng',
    'Đang giữ',
    'Chờ nấu',
    'Xem mã tem',
  ])
    assert.ok(html.includes(value));
  assert.match(html, />10<\/td>/);
  assert.match(html, />6<\/td>/);
});
test('clicking tag drilldown passes the selected variant, not product or foreign branch', () => {
  let selected;
  const tree = StockSummaryTable({
    rows: [row],
    onSelectVariant(id) {
      selected = id;
    },
  });
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.props?.children === 'Xem mã tem') node.props.onClick();
    React.Children.forEach(node.props?.children, visit);
  }
  visit(tree);
  assert.equal(selected, row.variantId);
});
