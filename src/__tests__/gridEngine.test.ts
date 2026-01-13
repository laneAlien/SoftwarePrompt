import { runGridBacktest } from '../strategies/gridEngine';

describe('runGridBacktest', () => {
  it('executes grid orders using high/low path on synthetic candle', () => {
    const result = runGridBacktest({
      ohlcv: [
        {
          timestamp: 0,
          open: 100,
          high: 110,
          low: 90,
          close: 100,
          volume: 0,
        },
      ],
      low: 90,
      high: 110,
      grids: 3,
      allocation: 200,
      feeRate: 0.001,
    });

    expect(result.tradesCount).toBe(3);
    expect(result.turnover).toBe(300);
    expect(result.feesTotal).toBeCloseTo(0.3, 6);
    expect(result.feeRatio).toBeCloseTo(0.001, 6);
  });
});
