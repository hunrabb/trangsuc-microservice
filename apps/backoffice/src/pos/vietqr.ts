import type { PosOrder } from '@jewelry/contracts';

export interface BankAccount {
  bin: string;
  account: string;
  name: string;
}

/** Chỉ kích hoạt QR khi cả ba thông tin nhận tiền thật đều được cấu hình hợp lệ. */
export function bankAccountFromEnvironment(): BankAccount | null {
  const bin = String(import.meta.env.VITE_POS_BANK_BIN ?? '').trim();
  const account = String(import.meta.env.VITE_POS_BANK_ACCOUNT ?? '').trim();
  const name = String(import.meta.env.VITE_POS_BANK_NAME ?? '').trim();
  if (!/^\d{6}$/.test(bin) || !/^\d{6,19}$/.test(account) || !/^[A-Za-z0-9 ]{5,50}$/.test(name))
    return null;
  return { bin, account, name };
}

/** Chỉ dùng tổng tiền đã chốt và mã đơn từ Sales, không tính lại từ giá trong giỏ. */
export function vietQrUrl(order: PosOrder, bank: BankAccount | null): string | null {
  if (bank === null || order.status !== 'PENDING_PAYMENT') return null;
  if (!/^[1-9]\d{0,12}\.00$/.test(order.total) || !/^[A-Za-z0-9]{1,50}$/.test(order.code))
    return null;
  const url = new URL(`https://img.vietqr.io/image/${bank.bin}-${bank.account}-compact2.png`);
  url.searchParams.set('amount', order.total.slice(0, -3));
  url.searchParams.set('addInfo', order.code);
  url.searchParams.set('accountName', bank.name);
  return url.toString();
}
