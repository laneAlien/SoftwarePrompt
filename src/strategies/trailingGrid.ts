import { OHLCV } from '../real/ohlcv';
import { parseTimeframeToMs } from '../core/utils';
import { GridResult, runGridBacktest } from './gridEngine';

export interface TrailingGridOptions {
  sourceTimeframe?: string;
  resampleTo15m?: boolean;
}

function resampleOhlcv(ohlcv: OHLCV[], timeframeMs: number): OHLCV[] {
  if (ohlcv.length === 0) return [];
  const sorted = [...ohlcv].sort((a, b) => a.timestamp - b.timestamp);
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

export function backtestTrailingGrid(
  ohlcv: OHLCV[],
  low: number,
  high: number,
  grids: number,
  allocation: number,
  trailStepPercent: number,
  feeRate: number = 0.002,
  options: TrailingGridOptions = {}
): GridResult {
  const normalizedTimeframe = options.sourceTimeframe?.toLowerCase();
  const shouldResample = options.resampleTo15m ?? normalizedTimeframe === '1m';
  const ohlcv15m = shouldResample ? resampleOhlcv(ohlcv, parseTimeframeToMs('15m')) : ohlcv;

  return runGridBacktest({
    ohlcv: ohlcv15m,
    low,
    high,
    grids,
    allocation,
    feeRate,
    trailStepPercent,
    stopOnMa30: true,
    stopOnLowCloses: 2,
  });
}

export { GridResult };
