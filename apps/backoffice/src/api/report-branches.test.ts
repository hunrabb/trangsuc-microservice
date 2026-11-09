import assert from 'node:assert/strict';
import { it } from 'node:test';
import { loadReportBranchOptions } from './report-branches.ts';

it('ADMIN tải được các chi nhánh sau trang 100; số trang hữu hạn và dedup khi danh sách đổi', async () => {
  const pages: number[] = [];
  const data = await loadReportBranchOptions(async (page, size) => {
    pages.push(page);
    assert.equal(size, 100);
    return {
      total: page === 1 ? 201 : 10000,
      items:
        page === 1
          ? [{ id: 'A', name: 'A' }]
          : [
              { id: 'A', name: 'A' },
              { id: String(page), name: `Chi nhánh ${page}` },
            ],
    };
  });
  assert.deepEqual(pages, [1, 2, 3]);
  assert.deepEqual(
    data.map((row) => row.id),
    ['A', '2', '3'],
  );
});

it('dừng khi trang rỗng, lỗi danh sách chi nhánh được chuyển cho Query hiển thị', async () => {
  let calls = 0;
  await loadReportBranchOptions(async () => {
    calls++;
    return { total: 500, items: [] };
  });
  assert.equal(calls, 2);
  await assert.rejects(
    () =>
      loadReportBranchOptions(async () => {
        throw new Error('fixture unavailable');
      }),
    /fixture unavailable/,
  );
});
