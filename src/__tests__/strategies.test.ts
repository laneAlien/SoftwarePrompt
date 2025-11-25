import { FundingStrategy } from '../strategies/fundingStrategy';
import { VolumeStrategy } from '../strategies/volumeStrategy';
import { MultiTimeframeStrategy } from '../strategies/multiTimeframeStrategy';
import { StrategyContext } from '../core/types';

const baseCtx: StrategyContext = {
  symbol: 'BTC/USDT',
  timeframe: '1h',
  candles: [],
  indicators: {},
  currentPrice: 100,
  position: null,
};

describe('strategies', () => {
  it('funding strategy reacts to funding rate', () => {
    const strat = new FundingStrategy();
    const signal = strat.generateSignal({ ...baseCtx, indicators: { fundingRate: 0.002 } });
    expect(signal.action).toBe('sell');
  });

  it('volume strategy prefers positive obv slope', () => {
    const strat = new VolumeStrategy();
    const signal = strat.generateSignal({ ...baseCtx, indicators: { obv: 100, vwap: 95 } });
    expect(signal.confidence).toBeGreaterThan(0);
  });

  it('multi-timeframe strategy aggregates sub-signals', () => {
    const strat = new MultiTimeframeStrategy();
    const signal = strat.generateSignal({ ...baseCtx, indicators: { rsi: 40, emaFast: 90, emaSlow: 80 } });
    expect(signal.strategyName).toBe('Multi-Timeframe');
  });
});
