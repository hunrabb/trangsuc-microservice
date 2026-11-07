import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decimal } from '@prisma/client/runtime/client';
import { computeItemPrice, roundToThousand } from './pricing.ts';

const price = (weight: string, sell: string, labor: string) =>
  computeItemPrice(new Decimal(weight), new Decimal(sell), new Decimal(labor)).toFixed(2);

describe('tính giá', () => {
  it('= trọng lượng × giá bán ra + tiền công, làm tròn tới 1.000 đồng một lần ở cuối', () => {
    // 1,2345 chỉ × 3.500.000 = 4.320.750; + 150.000 = 4.470.750 → 4.471.000
    assert.equal(price('1.2345', '3500000', '150000'), '4471000.00');
    // Tròn sẵn thì giữ nguyên: 2 × 3.000.000 + 200.000.
    assert.equal(price('2', '3000000', '200000'), '6200000.00');
    // Làm tròn từng thành phần sẽ ra 4.320.000 + 150.000: lệch 1.000 so với làm tròn cuối.
    assert.notEqual(price('1.2345', '3500000', '150000'), '4470000.00');
  });

  it('làm tròn nửa lên đúng ở ranh giới 500 đồng', () => {
    const round = (value: string) => roundToThousand(new Decimal(value)).toFixed(0);
    assert.equal(round('1499.99'), '1000');
    assert.equal(round('1500'), '2000');
    assert.equal(round('2500'), '3000');
    assert.equal(round('0'), '0');
  });

  it('không mất độ chính xác với trọng lượng 4 chữ số thập phân (số float sẽ sai)', () => {
    // 0,0001 chỉ × 3.333.333 = 333,3333 → 0 ; + công 1.000 = 1.333,3333 → 1.000
    assert.equal(price('0.0001', '3333333', '1000'), '1000.00');
  });
});
