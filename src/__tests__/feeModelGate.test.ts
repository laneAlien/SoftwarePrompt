import { calculateFee } from '../core/feeModelGate';

describe('calculateFee', () => {
  it('applies GT discount and voucher percent on base fee', () => {
    const fee = calculateFee(1000, true, {
      makerRate: 0.001,
      takerRate: 0.002,
      gtDiscountRate: 20,
      voucherDiscount: {
        type: 'percent',
        value: 10,
      },
      minimumFee: 0.5,
    });

    expect(fee).toBeCloseTo(0.72, 6);
  });

  it('respects minimum fee after fixed voucher discount', () => {
    const fee = calculateFee(100, true, {
      makerRate: 0.001,
      takerRate: 0.002,
      gtDiscountRate: 0,
      voucherDiscount: {
        type: 'fixed',
        value: 0.2,
      },
      minimumFee: 0.05,
    });

    expect(fee).toBeCloseTo(0.05, 6);
  });
});
