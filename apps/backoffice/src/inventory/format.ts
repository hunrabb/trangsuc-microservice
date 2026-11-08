/**
 * Hiển thị tiền và trọng lượng từ chuỗi thập phân của server. Làm bằng chuỗi, không đổi sang số thực, để không
 * mất độ chính xác (giá trị vẫn là chuỗi từ lúc nhận tới lúc hiện ra).
 */

/** "4471000.00" → "4.471.000 ₫". Phần thập phân toàn số 0 thì bỏ. */
export function formatMoney(value: string | null): string {
  if (value === null) {
    return '—';
  }
  const [integerPart = '0', fractionPart = ''] = value.split('.');
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const hasFraction = /[1-9]/.test(fractionPart);
  return `${grouped}${hasFraction ? `,${fractionPart}` : ''} ₫`;
}

/** "1.2345" → "1,2345 chỉ"; "2.0000" → "2 chỉ". */
export function formatWeight(value: string): string {
  const [integerPart = '0', fractionPart = ''] = value.split('.');
  const trimmedFraction = fractionPart.replace(/0+$/, '');
  return `${integerPart}${trimmedFraction === '' ? '' : `,${trimmedFraction}`} chỉ`;
}

export const formatDateTime = (isoDate: string): string =>
  new Date(isoDate).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

export const METAL_KIND_LABELS = { GOLD: 'Vàng', SILVER: 'Bạc' } as const;

export const ITEM_STATUS_LABELS = {
  IN_STOCK: 'Trong kho',
  RESERVED: 'Đang giữ',
  SOLD: 'Đã bán',
} as const;

export const RECEIPT_STATUS_LABELS = { DRAFT: 'Nháp', APPROVED: 'Đã duyệt' } as const;

/** Số thập phân không âm tối đa `maxFraction` chữ số thập phân, dùng để kiểm tra ô nhập trước khi gửi. */
export const isDecimalText = (value: string, maxFraction: number): boolean =>
  new RegExp(`^\\d{1,13}(\\.\\d{1,${maxFraction}})?$`).test(value.trim());

export const isZeroText = (value: string): boolean => /^0+(\.0+)?$/.test(value.trim());
