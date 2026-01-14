import { OHLCV } from '../real/ohlcv';
import { resampleCandles } from '../core/resample';
import { parseTimeframeToMs } from '../core/utils';
import { GridEngineOptions, GridResult, runGridBacktest } from './gridEngine';

export interface TrailingGridOptions {
  sourceTimeframe?: string;
  resampleTo15m?: boolean;
  maTimeframe?: '15m' | 'native';
  stopOnMa30?: boolean;
  stopOnLowCloses?: number;
}

function resampleOhlcvForStops(ohlcv: OHLCV[], targetTimeframe: string): OHLCV[] {
  if (ohlcv.length === 0) return [];
  const timeframeMs = parseTimeframeToMs(targetTimeframe);
  const sorted = [...ohlcv].sort((a, b) => a.timestamp - b.timestamp);
  const resampled = resampleCandles(sorted, targetTimeframe);
  const bucketLastTimestamp = new Map<number, number>();

  for (const candle of sorted) {
    const bucketStart = Math.floor(candle.timestamp / timeframeMs) * timeframeMs;
    bucketLastTimestamp.set(bucketStart, candle.timestamp);
  }

  return resampled.map((candle) => ({
    ...candle,
    timestamp: bucketLastTimestamp.get(candle.timestamp) ?? candle.timestamp,
  }));
}

export type BacktestTrailingGridParams = GridEngineOptions & TrailingGridOptions;

export function backtestTrailingGrid(params: BacktestTrailingGridParams): GridResult {
  const normalizedTimeframe = params.sourceTimeframe?.toLowerCase();
  const shouldResample = params.resampleTo15m ?? normalizedTimeframe === '1m';
  const ohlcv15m = shouldResample ? resampleCandles(params.ohlcv, '15m') : params.ohlcv;
  const maTimeframe = params.maTimeframe ?? '15m';
  const stopOhlcv = maTimeframe === '15m' ? resampleOhlcvForStops(params.ohlcv, '15m') : undefined;

  return runGridBacktest({
    ...params,
    ohlcv: normalizedTimeframe === '1m' ? params.ohlcv : ohlcv15m,
    stopOhlcv,
    stopOnMa30: params.stopOnMa30 ?? true,
    stopOnLowCloses: params.stopOnLowCloses ?? 2,
  });
}

export { GridResult };
