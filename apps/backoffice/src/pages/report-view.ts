import type { BranchRole } from '@jewelry/contracts';
import type { DailyRow, ReportFilter } from '../api/report-types.ts';
import { canViewReports, isAdmin, managedBranchIds } from '../auth/permissions.ts';

export const ALL_REPORT_BRANCHES = '*';
type NamedRole = BranchRole & { branchName?: string | null };

/** MANAGER chỉ lấy tên từ /me; không gọi danh sách toàn hệ thống. */
export function reportBranches(
  roles: readonly NamedRole[],
  branches: readonly { id: string; name: string }[],
) {
  if (isAdmin(roles))
    return [
      { value: ALL_REPORT_BRANCHES, label: 'Tất cả chi nhánh' },
      ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
    ];
  return [...new Set(managedBranchIds(roles))].map((id) => ({
    value: id,
    label: roles.find((role) => role.branchId === id)?.branchName ?? 'Chi nhánh được phân quyền',
  }));
}

export function vietnamToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export const reportDate = (date: string) => date.split('-').reverse().join('/');

export function reportFilterInput(
  roles: readonly BranchRole[],
  from: string,
  to: string,
  branch: string,
): { filter?: ReportFilter; error?: string } {
  if (!canViewReports(roles)) return { error: 'Bạn không có quyền xem báo cáo.' };
  const validDate = (date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  };
  if (!validDate(from) || !validDate(to) || from > to)
    return {
      error: 'Chọn ngày bắt đầu và kết thúc hợp lệ, ngày kết thúc không trước ngày bắt đầu.',
    };
  if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000)
    return { error: 'Khoảng báo cáo không được vượt quá 366 ngày.' };
  if (branch === ALL_REPORT_BRANCHES && isAdmin(roles)) return { filter: { from, to } };
  if (
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(branch) ||
    (!isAdmin(roles) && !managedBranchIds(roles).includes(branch))
  )
    return { error: 'Chọn một chi nhánh được phân quyền xem báo cáo.' };
  return { filter: { from, to, branchId: branch } };
}

export function canExportReport(filter?: ReportFilter): boolean {
  return filter !== undefined && Date.parse(filter.to) - Date.parse(filter.from) <= 30 * 86_400_000;
}

/** Cộng tiền bằng BigInt, giữ COGS/lợi nhuận thiếu là null. */
export function reportTotals(rows: readonly DailyRow[]) {
  const cents = (value: string) => {
    const negative = value.startsWith('-');
    const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
    return (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))) * (negative ? -1n : 1n);
  };
  const decimal = (value: bigint) => {
    const abs = value < 0n ? -value : value;
    return `${value < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
  };
  const revenue = rows.reduce((sum, row) => sum + cents(row.revenue), 0n);
  const cogs = rows.some((row) => row.cogs === null)
    ? null
    : rows.reduce((sum, row) => sum + cents(row.cogs!), 0n);
  return {
    revenue: decimal(revenue),
    cogs: cogs === null ? null : decimal(cogs),
    grossProfit: cogs === null ? null : decimal(revenue - cogs),
    orderCount: rows.reduce((sum, row) => sum + row.orderCount, 0),
  };
}

export const stockReason = (reason: string | null): string =>
  ({
    MISSING_SNAPSHOT: 'Thiếu bản chốt kho',
    BROKEN_SNAPSHOT_CHAIN: 'Các bản chốt không nối tiếp',
    RECONCILIATION_FAILED: 'Số liệu tồn kho chưa đối soát khớp',
  })[reason ?? ''] ?? 'Chưa đủ dữ liệu tồn kho';
