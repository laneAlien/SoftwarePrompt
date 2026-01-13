import { OHLCV } from '../real/ohlcv';
import { GridResult, runGridBacktest } from './gridEngine';

export { GridResult };

export function backtestSpotGrid(
  ohlcv: OHLCV[],
  low: number,
  high: number,
  grids: number,
  allocation: number,
  feeRate: number = 0.002
): GridResult {
  return runGridBacktest({
    ohlcv,
    low,
    high,
    grids,
    allocation,
    feeRate,
  });
}
