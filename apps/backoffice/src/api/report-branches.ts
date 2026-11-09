interface BranchOption {
  id: string;
  name: string;
}
interface BranchPage {
  items: BranchOption[];
  total: number;
}

/** Chỉ ADMIN gọi. Đóng số trang theo page đầu để không chạy vô hạn nếu danh sách đang tăng. */
export async function loadReportBranchOptions(
  listPage: (page: number, size: number) => Promise<BranchPage>,
): Promise<BranchOption[]> {
  const first = await listPage(1, 100);
  const rows = [...first.items];
  for (let page = 2; page <= Math.ceil(first.total / 100); page++) {
    const result = await listPage(page, 100);
    rows.push(...result.items);
    if (result.items.length === 0) break;
  }
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}
