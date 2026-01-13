import { OHLCV } from '../real/ohlcv';
import { GridResult, runGridBacktest } from './gridEngine';

export function backtestTrailingGrid(
  ohlcv: OHLCV[],
  low: number,
  high: number,
  grids: number,
  allocation: number,
  trailStepPercent: number,
  feeRate: number = 0.002
): GridResult {
  return runGridBacktest({
    ohlcv,
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
