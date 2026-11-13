import type { CurrentUser, ItemWithPrice, SettlementView } from '@jewelry/contracts';
import { hasRoleAtBranch } from '../auth/permissions.ts';

export const SETTLEMENT_STATUS: Record<SettlementView['status'], { label: string; color: string }> =
  {
    RESERVING: { label: 'Đang giữ trang sức', color: 'yellow' },
    AWAITING_PAYMENT: { label: 'Chờ ghi chứng từ', color: 'blue' },
    PAYMENT_RECORDED: { label: 'Đã ghi chứng từ, chờ xác nhận', color: 'orange' },
    FULFILLING: { label: 'Đang hoàn tất đổi hàng', color: 'yellow' },
    SETTLED: { label: 'Đã hoàn tất', color: 'green' },
    RECONCILIATION_REQUIRED: { label: 'Cần đối soát', color: 'red' },
    CANCELLING: { label: 'Đang hủy và nhả giữ hàng', color: 'yellow' },
    CANCELLED: { label: 'Đã hủy', color: 'gray' },
  };

export const DIRECTION: Record<NonNullable<SettlementView['direction']>, string> = {
  CUSTOMER_PAYS: 'Khách trả thêm',
  STORE_PAYS: 'Cửa hàng chi trả',
  NONE: 'Không thu/chi chênh lệch',
};

export function canConfirmSettlement(
  me: CurrentUser | undefined,
  row: SettlementView,
): string | null {
  if (!me || !hasRoleAtBranch(me.branches, row.branchId, ['MANAGER']))
    return 'Chỉ quản lý chi nhánh hoặc ADMIN được xác nhận.';
  if (row.status !== 'PAYMENT_RECORDED') return 'Chỉ xác nhận sau khi đã ghi chứng từ.';
  if (me.id === row.createdBy || me.id === row.paymentRecordedBy)
    return 'Người xác nhận phải khác người lập giao dịch và người ghi chứng từ.';
  return null;
}

export const exchangeItemAvailable = (item: ItemWithPrice | undefined, branchId: string): boolean =>
  item?.branchId === branchId && item.status === 'IN_STOCK';

/** Cùng một command giữ nguyên key khi kết quả HTTP chưa rõ; click đôi chỉ gửi một request. */
export class SettlementCommandGate {
  private running: Promise<unknown> | null = null;
  private keys = new Map<string, string>();

  run<T>(signature: string, send: (key: string) => Promise<T>): Promise<T> {
    if (this.running) return this.running as Promise<T>;
    const key = this.keys.get(signature) ?? crypto.randomUUID();
    this.keys.set(signature, key);
    const operation = send(key).then((result) => {
      this.keys.delete(signature);
      return result;
    });
    this.running = operation.finally(() => {
      this.running = null;
    });
    return this.running as Promise<T>;
  }
}
