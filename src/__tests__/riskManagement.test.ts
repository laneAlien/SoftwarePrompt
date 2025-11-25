import { calculateMaxDrawdown, determineRiskLevelFromMetrics, adjustAggressiveness } from '../real/riskManagement';
import { Candle } from '../core/types';

const makeCandles = (prices: number[]): Candle[] =>
  prices.map((p, i) => ({ timestamp: i, open: p, high: p, low: p, close: p, volume: 1, timeframe: '1h' }));

describe('riskManagement', () => {
  it('calculates drawdown', () => {
    const dd = calculateMaxDrawdown(makeCandles([100, 120, 80, 90]));
    expect(dd).toBeCloseTo(33.3333, 1);
  });

  it('assigns risk level', () => {
    const level = determineRiskLevelFromMetrics({ maxDrawdownPercent: 30, volatility: 0.05 });
    expect(level).toBe('high');
  });

  it('adjusts aggressiveness by funding', () => {
    const adjusted = adjustAggressiveness(1, { maxDrawdownPercent: 5, volatility: 0.05 }, 0.003);
    expect(adjusted).toBeLessThan(1);
  });
});
