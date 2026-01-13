import { OHLCV } from '../real/ohlcv';
import { parseTimeframeToMs } from '../core/utils';
import { GridEngineOptions, GridResult, runGridBacktest } from './gridEngine';

export interface TrailingGridOptions {
  sourceTimeframe?: string;
  resampleTo15m?: boolean;
  stopOnMa30?: boolean;
  stopOnLowCloses?: number;
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

function resampleOhlcvForStops(ohlcv: OHLCV[], timeframeMs: number): OHLCV[] {
  if (ohlcv.length === 0) return [];
  const sorted = [...ohlcv].sort((a, b) => a.timestamp - b.timestamp);
  const resampled: OHLCV[] = [];
  let bucketStart = Math.floor(sorted[0].timestamp / timeframeMs) * timeframeMs;
  let lastTimestamp = sorted[0].timestamp;
  let current: OHLCV = {
    timestamp: sorted[0].timestamp,
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
      resampled.push({ ...current, timestamp: lastTimestamp });
      bucketStart = nextBucketStart;
      current = {
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      };
      lastTimestamp = candle.timestamp;
      continue;
    }

    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
    lastTimestamp = candle.timestamp;
  }

  resampled.push({ ...current, timestamp: lastTimestamp });
  return resampled;
}

export type BacktestTrailingGridParams = GridEngineOptions & TrailingGridOptions;

export function backtestTrailingGrid(params: BacktestTrailingGridParams): GridResult {
  const normalizedTimeframe = params.sourceTimeframe?.toLowerCase();
  const shouldResample = params.resampleTo15m ?? normalizedTimeframe === '1m';
  const ohlcv15m = shouldResample ? resampleOhlcv(params.ohlcv, parseTimeframeToMs('15m')) : params.ohlcv;
  const stopOhlcv =
    shouldResample && normalizedTimeframe === '1m'
      ? resampleOhlcvForStops(params.ohlcv, parseTimeframeToMs('15m'))
      : undefined;

  return runGridBacktest({
    ...params,
    ohlcv: normalizedTimeframe === '1m' ? params.ohlcv : ohlcv15m,
    stopOhlcv,
    stopOnMa30: params.stopOnMa30 ?? true,
    stopOnLowCloses: params.stopOnLowCloses ?? 2,
  });
}

export { GridResult };
