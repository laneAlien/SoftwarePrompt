import { Candle } from '../core/types';

export function calculateOBV(candles: Candle[]): number[] {
  const obv: number[] = [];
  let current = 0;

  for (let i = 0; i < candles.length; i++) {
    const prevClose = i > 0 ? candles[i - 1].close : candles[i].close;
    if (candles[i].close > prevClose) {
      current += candles[i].volume;
    } else if (candles[i].close < prevClose) {
      current -= candles[i].volume;
    }
    obv.push(current);
  }

  return obv;
}

