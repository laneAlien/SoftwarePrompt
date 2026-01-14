import { OHLCV } from '../real/ohlcv';
import { parseTimeframeToMs } from './utils';

export function resampleCandles(candles: OHLCV[], targetTimeframe: string = '15m'): OHLCV[] {
  if (candles.length === 0) return [];
  const timeframeMs = parseTimeframeToMs(targetTimeframe);
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const resampled: OHLCV[] = [];
  let bucketStart = Math.floor(sorted[0].timestamp / timeframeMs) * timeframeMs;
  let current: OHLCV = {
    timestamp: bucketStart,
    open: sorted[0].open,
    high: sorted[0].high,
    low: sorted[0].low,
    close: sorted[0].close,
    volume: sorted[0].volume,
  };

  for (let i = 1; i < sorted.length; i += 1) {
    const candle = sorted[i];
    const nextBucketStart = Math.floor(candle.timestamp / timeframeMs) * timeframeMs;
    if (nextBucketStart !== bucketStart) {
      resampled.push(current);
      bucketStart = nextBucketStart;
      current = {
        timestamp: bucketStart,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      };
      continue;
    }

    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
  }

  resampled.push(current);
  return resampled;
}
