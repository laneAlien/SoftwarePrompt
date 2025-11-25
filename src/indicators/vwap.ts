import { Candle } from '../core/types';

export function calculateVWAP(candles: Candle[]): number[] {
  const vwap: number[] = [];
  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (const candle of candles) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativePV += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
    vwap.push(cumulativeVolume ? cumulativePV / cumulativeVolume : typicalPrice);
  }

  return vwap;
}

