import { Decimal } from '@prisma/client/runtime/client';

/** Giá bán làm tròn tới bội số của 1.000 đồng. */
export const PRICE_ROUNDING_STEP = 1000;

/** Làm tròn "nửa lên" (500 → 1.000). Số tiền âm không có nghĩa ở đây nên không xử lý riêng. */
export function roundToThousand(amount: Decimal): Decimal {
  return amount
    .div(PRICE_ROUNDING_STEP)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .mul(PRICE_ROUNDING_STEP);
}

/**
 * Hàm tính giá DUY NHẤT của inventory: giá = trọng lượng (chỉ) × giá bán ra của kim loại (đồng / chỉ) + tiền công,
 * rồi làm tròn tới 1.000 đồng. Làm tròn một lần ở cuối, không làm tròn từng thành phần, để tổng không lệch.
 * Giá này chỉ để xem; giá chốt lúc bán do sales ghi lại vào hoá đơn, không bao giờ tính lại theo giá mới.
 */
export function computeItemPrice(
  weight: Decimal,
  sellPricePerChi: Decimal,
  laborFee: Decimal,
): Decimal {
  return roundToThousand(weight.mul(sellPricePerChi).add(laborFee));
}
