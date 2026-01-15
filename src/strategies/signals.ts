import { Candle } from '../core/types';
import { MarketRegime } from '../core/regime';
import { TaFeatures } from '../ta/features';

export type SignalAction = 'BUY' | 'SELL' | 'HOLD';

export interface SignalResult {
  action: SignalAction;
  confidence: number;
  reason: string;
  stop?: number;
  take?: number;
}

export interface SignalFeatures {
  ta: TaFeatures;
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

const buildTrendSignal = (
  candles: Candle[],
  config: SignalConfig,
  ta: TaFeatures
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

  const emaFastValue = ta.ema50 ?? closePrices[lastIndex];
  const emaSlowValue = ta.ema200 ?? closePrices[lastIndex];

  const slopeIndex = Math.max(0, lastIndex - slopeWindow);
  const slopeStart = closePrices[slopeIndex] ?? emaFastValue;
  const slope = (emaFastValue - slopeStart) / Math.max(1, lastIndex - slopeIndex);
  const slopePct = emaFastValue !== 0 ? slope / emaFastValue : 0;
  const spreadPct = emaSlowValue !== 0 ? (emaFastValue - emaSlowValue) / emaSlowValue : 0;

  const trendStrength = Math.abs(spreadPct) + Math.abs(slopePct) * 3;
  const confidence = clamp(0.35 + trendStrength * 40, 0.2, 0.95);
  const atr = ta.atr14;
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
  ta: TaFeatures
): SignalResult => {
  const rsiPeriod = config.meanRsiPeriod ?? 14;
  const bollingerPeriod = config.meanBollingerPeriod ?? 20;
  const closePrices = candles.map((candle) => candle.close);
  const lastIndex = closePrices.length - 1;

  if (closePrices.length < Math.max(rsiPeriod, bollingerPeriod) + 1) {
    return {
      action: 'HOLD',
      confidence: 0.2,
      reason: 'Not enough candles for mean reversion signals',
    };
  }

  const rsiValue = ta.rsi14;
  const bollingerSet = {
    upper: ta.bbUpper,
    middle: ta.bbMid,
    lower: ta.bbLower,
  };

  if (Number.isNaN(rsiValue)) {
    return {
      action: 'HOLD',
      confidence: 0.2,
      reason: 'Indicators unavailable for mean reversion',
    };
  }

  const latestPrice = closePrices[lastIndex];
  const bandWidth = bollingerSet.upper - bollingerSet.lower;
  const atr = ta.atr14;

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
    return buildMeanRevertSignal(candles, config, features.ta);
  }

  return buildTrendSignal(candles, config, features.ta);
}
