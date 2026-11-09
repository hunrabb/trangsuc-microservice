import assert from 'node:assert/strict';
import { it } from 'node:test';
import { canViewReports } from '../auth/permissions.ts';
import {
  canExportReport,
  reportBranches,
  reportFilterInput,
  reportTotals,
  vietnamToday,
} from './report-view.ts';
const own = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const admin = [{ role: 'ADMIN' as const, branchId: null }];
const manager = [
  { role: 'MANAGER' as const, branchId: own, branchName: 'Chi nhánh A' },
  { role: 'STAFF' as const, branchId: other, branchName: 'Chi nhánh B' },
];

it('chỉ ADMIN/MANAGER được xem; MANAGER không thấy hoặc chọn chi nhánh STAFF/ngoài scope', () => {
  assert.equal(canViewReports(admin), true);
  assert.equal(canViewReports(manager), true);
  assert.equal(canViewReports([{ role: 'STAFF', branchId: own }]), false);
  assert.deepEqual(reportBranches(manager, [{ id: other, name: 'Không được phép' }]), [
    { value: own, label: 'Chi nhánh A' },
  ]);
  assert.equal(reportBranches(admin, [{ id: other, name: 'B' }])[0]?.value, '*');
  assert.equal(reportFilterInput(manager, '2026-11-01', '2026-11-09', own).filter?.branchId, own);
  assert.ok(reportFilterInput(manager, '2026-11-01', '2026-11-09', other).error);
  assert.ok(reportFilterInput(manager, '2026-11-01', '2026-11-09', '*').error);
  assert.deepEqual(reportFilterInput(admin, '2026-11-01', '2026-11-09', '*').filter, {
    from: '2026-11-01',
    to: '2026-11-09',
  });
});
it('lọc ngày thật, từ<=đến, giới hạn API/Excel và ngày theo múi giờ Việt Nam', () => {
  for (const [from, to] of [
    ['2026-02-30', '2026-03-02'],
    ['2026-11-09', '2026-11-01'],
    ['', '2026-11-01'],
    ['2024-01-01', '2026-01-01'],
  ]) {
    assert.ok(reportFilterInput(admin, from!, to!, '*').error);
  }
  assert.equal(canExportReport({ from: '2026-01-01', to: '2026-01-31' }), true);
  assert.equal(canExportReport({ from: '2026-01-01', to: '2026-02-01' }), false);
  assert.equal(vietnamToday(new Date('2026-11-08T18:00:00Z')), '2026-11-09');
});
it('tổng doanh thu giữ đúng tiền lớn và số lẻ; thiếu vốn không suy diễn lợi nhuận', () => {
  const row = {
    date: '2026-11-01',
    branchId: own,
    channel: 'POS',
    orderCount: 1,
    revenue: '9999999999999.99',
    cogs: '9999999999998.99',
    grossProfit: '1.00',
  };
  assert.deepEqual(reportTotals([row, row]), {
    revenue: '19999999999999.98',
    cogs: '19999999999997.98',
    grossProfit: '2.00',
    orderCount: 2,
  });
  assert.equal(reportTotals([row, { ...row, cogs: null, grossProfit: null }]).grossProfit, null);
  assert.equal(reportTotals([{ ...row, revenue: '0.10', cogs: '0.20' }]).grossProfit, '-0.10');
});
