import { BusinessError } from '@jewelry/common';
import { Prisma } from '../generated/prisma/client';

export const BUYBACK_ROUNDING = 'HALF_UP_1000_VND_PER_LINE' as const;
/** The Inventory rate already prices this alloy/fineness. Never multiply purity again. */
export function priceBuybackLine(
  acceptedWeight: Prisma.Decimal,
  buyPricePerChi: Prisma.Decimal,
  deductionVndPerItem: Prisma.Decimal,
): Prisma.Decimal {
  if (
    [acceptedWeight, buyPricePerChi, deductionVndPerItem].some((value) => !value.isFinite()) ||
    acceptedWeight.lte(0) ||
    buyPricePerChi.lte(0) ||
    deductionVndPerItem.lt(0)
  )
    throw new BusinessError('BUYBACK_PRICE_INVALID', 'Trọng lượng/giá/khấu trừ không hợp lệ', 409);
  const Exact = Prisma.Decimal.clone({ precision: 48 });
  const net = new Exact(acceptedWeight.toString())
    .mul(buyPricePerChi.toString())
    .sub(deductionVndPerItem.toString());
  if (net.lt(0)) throw new BusinessError('BUYBACK_PRICE_INVALID', 'Khấu trừ vượt giá trị món', 409);
  const amount = net.div(1000).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).mul(1000);
  if (amount.gte('1000000000000000000'))
    throw new BusinessError('BUYBACK_PRICE_INVALID', 'Thành tiền vượt giới hạn lưu trữ', 409);
  return new Prisma.Decimal(amount.toFixed(2));
}
