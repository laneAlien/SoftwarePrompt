import { Candle } from '../core/types';
import { atr, bollinger, ema, rsi } from './indicators';

export type TrendState = 'up' | 'down' | 'sideways';
export type VolatilityState = 'low' | 'mid' | 'high';

export interface TaFeatures {
  rsi14: number;
  ema50: number;
  ema200: number;
  atr14: number;
  bbUpper: number;
  bbMid: number;
  bbLower: number;
  trend: TrendState;
  volatility: VolatilityState;
}

const safeNumber = (value: number | null | undefined, fallback: number): number =>
  Number.isFinite(value) ? (value as number) : fallback;

const determineTrend = (emaFast: number, emaSlow: number): TrendState => {
  const spread = emaSlow !== 0 ? (emaFast - emaSlow) / emaSlow : 0;
  if (spread > 0.002) return 'up';
  if (spread < -0.002) return 'down';
  return 'sideways';
};

const determineVolatility = (atrValue: number, price: number): VolatilityState => {
  if (price <= 0) return 'mid';
  const ratio = atrValue / price;
  if (ratio < 0.005) return 'low';
  if (ratio < 0.015) return 'mid';
  return 'high';
};

export const computeFeatures = (candles: Candle[]): TaFeatures => {
  const lastCandle = candles[candles.length - 1];
  const lastClose = lastCandle?.close ?? 0;
  const closes = candles.map((candle) => candle.close);

  const rsi14 = safeNumber(rsi(closes, 14), 50);
  const ema50 = safeNumber(ema(closes, 50), lastClose);
  const ema200 = safeNumber(ema(closes, 200), lastClose);
  const atr14 = safeNumber(atr(candles, 14), 0);
  const bb = bollinger(closes, 20, 2) ?? {
    upper: lastClose,
    middle: lastClose,
    lower: lastClose,
  };

  const trend = determineTrend(ema50, ema200);
  const volatility = determineVolatility(atr14, lastClose);

  return {
    rsi14,
    ema50,
    ema200,
    atr14,
    bbUpper: bb.upper,
    bbMid: bb.middle,
    bbLower: bb.lower,
    trend,
    volatility,
  };
};
