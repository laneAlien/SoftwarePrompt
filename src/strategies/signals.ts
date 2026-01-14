import { Candle, IndicatorSet } from '../core/types';
import { MarketRegime } from '../core/regime';
import { ema } from '../indicators/ema';
import { rsi } from '../indicators/rsi';
import { bollinger } from '../indicators/bollinger';

export type SignalAction = 'BUY' | 'SELL' | 'HOLD';

export interface SignalResult {
  action: SignalAction;
  confidence: number;
  reason: string;
  stop?: number;
  take?: number;
}

export interface SignalFeatures {
  indicators?: IndicatorSet;
  regime?: MarketRegime;
}

export interface SignalConfig {
  strategy: 'trend' | 'mean' | 'auto';
  trendFastPeriod?: number;
  trendSlowPeriod?: number;
  trendSlopeWindow?: number;
  meanRsiPeriod?: number;
  meanBollingerPeriod?: number;
  meanBollingerStdDev?: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const average = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;

const calculateAtr = (candles: Candle[], length = 14): number => {
  if (candles.length < 2) return 0;
  const start = Math.max(1, candles.length - length);
  const ranges: number[] = [];
  for (let i = start; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    const highLow = current.high - current.low;
    const highClose = Math.abs(current.high - previous.close);
    const lowClose = Math.abs(current.low - previous.close);
    ranges.push(Math.max(highLow, highClose, lowClose));
  }
  return average(ranges);
};

const buildTrendSignal = (
  candles: Candle[],
  config: SignalConfig,
  indicators?: IndicatorSet
): SignalResult => {
  const fastPeriod = config.trendFastPeriod ?? 50;
  const slowPeriod = config.trendSlowPeriod ?? 200;
  const slopeWindow = Math.max(3, config.trendSlopeWindow ?? 10);
  const closePrices = candles.map((candle) => candle.close);
  const lastIndex = closePrices.length - 1;

  if (closePrices.length < slowPeriod + 2) {
    return {
      action: 'HOLD',
      confidence: 0.2,
      reason: 'Not enough candles for trend detection',
    };
  }

  const emaFastSeries = ema(closePrices, fastPeriod);
  const emaSlowSeries = ema(closePrices, slowPeriod);
  const emaFastValue = emaFastSeries[lastIndex] ?? indicators?.emaFast ?? closePrices[lastIndex];
  const emaSlowValue = emaSlowSeries[lastIndex] ?? indicators?.emaSlow ?? closePrices[lastIndex];

  const slopeIndex = Math.max(0, lastIndex - slopeWindow);
  const slopeStart = emaFastSeries[slopeIndex] ?? emaFastValue;
  const slope = (emaFastValue - slopeStart) / Math.max(1, lastIndex - slopeIndex);
  const slopePct = emaFastValue !== 0 ? slope / emaFastValue : 0;
  const spreadPct = emaSlowValue !== 0 ? (emaFastValue - emaSlowValue) / emaSlowValue : 0;

  const trendStrength = Math.abs(spreadPct) + Math.abs(slopePct) * 3;
  const confidence = clamp(0.35 + trendStrength * 40, 0.2, 0.95);
  const atr = calculateAtr(candles);
  const latestPrice = closePrices[lastIndex];

  if (emaFastValue > emaSlowValue && slope > 0) {
    return {
      action: 'BUY',
      confidence,
      reason: `Trend up: EMA${fastPeriod} above EMA${slowPeriod} with positive slope`,
      stop: atr ? latestPrice - atr * 1.5 : undefined,
      take: atr ? latestPrice + atr * 2 : undefined,
    };
  }

  if (emaFastValue < emaSlowValue && slope < 0) {
    return {
      action: 'SELL',
      confidence,
      reason: `Trend down: EMA${fastPeriod} below EMA${slowPeriod} with negative slope`,
      stop: atr ? latestPrice + atr * 1.5 : undefined,
      take: atr ? latestPrice - atr * 2 : undefined,
    };
  }

  return {
    action: 'HOLD',
    confidence: clamp(0.25 + trendStrength * 10, 0.1, 0.6),
    reason: 'Trend strength is weak or slope is flat',
  };
};

const buildMeanRevertSignal = (
  candles: Candle[],
  config: SignalConfig,
  indicators?: IndicatorSet
): SignalResult => {
  const rsiPeriod = config.meanRsiPeriod ?? 14;
  const bollingerPeriod = config.meanBollingerPeriod ?? 20;
  const bollingerStdDev = config.meanBollingerStdDev ?? 2;
  const closePrices = candles.map((candle) => candle.close);
  const lastIndex = closePrices.length - 1;

  if (closePrices.length < Math.max(rsiPeriod, bollingerPeriod) + 1) {
    return {
      action: 'HOLD',
      confidence: 0.2,
      reason: 'Not enough candles for mean reversion signals',
    };
  }

  const rsiSeries = rsi(closePrices, rsiPeriod);
  const rsiValue = indicators?.rsi ?? rsiSeries[lastIndex];
  const bollingerValues = bollinger(closePrices, bollingerPeriod, bollingerStdDev);
  const bollingerSet = indicators?.bollinger ?? {
    upper: bollingerValues.upper[lastIndex],
    middle: bollingerValues.middle[lastIndex],
    lower: bollingerValues.lower[lastIndex],
  };

  if (!bollingerSet || Number.isNaN(rsiValue)) {
    return {
      action: 'HOLD',
      confidence: 0.2,
      reason: 'Indicators unavailable for mean reversion',
    };
  }

  const latestPrice = closePrices[lastIndex];
  const bandWidth = bollingerSet.upper - bollingerSet.lower;
  const atr = calculateAtr(candles);

  if (latestPrice <= bollingerSet.lower && rsiValue <= 40) {
    const distanceScore = bandWidth > 0 ? (bollingerSet.lower - latestPrice) / bandWidth : 0;
    const rsiScore = (40 - rsiValue) / 40;
    const confidence = clamp(0.4 + distanceScore * 1.2 + rsiScore * 0.4, 0.2, 0.95);
    return {
      action: 'BUY',
      confidence,
      reason: 'Price below lower Bollinger band with oversold RSI',
      stop: atr ? latestPrice - atr * 1.1 : undefined,
      take: atr ? latestPrice + atr * 1.4 : undefined,
    };
  }

  if (latestPrice >= bollingerSet.upper && rsiValue >= 60) {
    const distanceScore = bandWidth > 0 ? (latestPrice - bollingerSet.upper) / bandWidth : 0;
    const rsiScore = (rsiValue - 60) / 40;
    const confidence = clamp(0.4 + distanceScore * 1.2 + rsiScore * 0.4, 0.2, 0.95);
    return {
      action: 'SELL',
      confidence,
      reason: 'Price above upper Bollinger band with overbought RSI',
      stop: atr ? latestPrice + atr * 1.1 : undefined,
      take: atr ? latestPrice - atr * 1.4 : undefined,
    };
  }

  return {
    action: 'HOLD',
    confidence: 0.3,
    reason: 'Price is within bands or RSI neutral',
  };
};

export function generateSignal(
  candles: Candle[],
  features: SignalFeatures,
  config: SignalConfig
): SignalResult {
  const regime = features.regime;
  const chosen =
    config.strategy === 'auto'
      ? regime === 'RANGE'
        ? 'mean'
        : 'trend'
      : config.strategy;

  if (chosen === 'mean') {
    return buildMeanRevertSignal(candles, config, features.indicators);
  }

  return buildTrendSignal(candles, config, features.indicators);
}
