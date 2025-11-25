import { Candle, IndicatorSet, MacdValue, BollingerBands } from '../core/types';
import { rsi } from './rsi';
import { ema } from './ema';
import { sma } from './sma';
import { macd } from './macd';
import { bollinger } from './bollinger';
import { calculateOBV } from './obv';
import { calculateVWAP } from './vwap';

export * from './rsi';
export * from './ema';
export * from './sma';
export * from './macd';
export * from './bollinger';
export * from './obv';
export * from './vwap';
export * from './fundingRate';

export function computeIndicators(candles: Candle[]): IndicatorSet {
  if (candles.length === 0) {
    return {};
  }

  const closePrices = candles.map((c) => c.close);
  const lastIndex = closePrices.length - 1;

  const indicators: IndicatorSet = {};

  if (closePrices.length >= 14) {
    const rsiValues = rsi(closePrices, 14);
    if (!isNaN(rsiValues[lastIndex])) {
      indicators.rsi = rsiValues[lastIndex];
    }
  }

  if (closePrices.length >= 26) {
    const macdValues = macd(closePrices, 12, 26, 9);
    if (!isNaN(macdValues.macd[lastIndex])) {
      indicators.macd = {
        macd: macdValues.macd[lastIndex],
        signal: macdValues.signal[lastIndex],
        histogram: macdValues.histogram[lastIndex],
      } as MacdValue;
    }
  }

  if (closePrices.length >= 12) {
    const emaFastValues = ema(closePrices, 12);
    if (!isNaN(emaFastValues[lastIndex])) {
      indicators.emaFast = emaFastValues[lastIndex];
    }
  }

  if (closePrices.length >= 26) {
    const emaSlowValues = ema(closePrices, 26);
    if (!isNaN(emaSlowValues[lastIndex])) {
      indicators.emaSlow = emaSlowValues[lastIndex];
    }
  }

  if (closePrices.length >= 20) {
    const smaValues = sma(closePrices, 20);
    if (!isNaN(smaValues[lastIndex])) {
      indicators.sma = smaValues[lastIndex];
    }
  }

  if (closePrices.length >= 20) {
    const bollingerValues = bollinger(closePrices, 20, 2);
    if (!isNaN(bollingerValues.upper[lastIndex])) {
      indicators.bollinger = {
        upper: bollingerValues.upper[lastIndex],
        middle: bollingerValues.middle[lastIndex],
        lower: bollingerValues.lower[lastIndex],
      } as BollingerBands;
    }
  }

  const obvSeries = calculateOBV(candles);
  indicators.obv = obvSeries[lastIndex];

  const vwapSeries = calculateVWAP(candles);
  indicators.vwap = vwapSeries[lastIndex];

  return indicators;
}
