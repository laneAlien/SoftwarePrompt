import { sma } from './sma';
import { stdDev } from '../core/utils';

export interface BollingerSeries {
  upper: number[];
  middle: number[];
  lower: number[];
}

export function bollinger(
  values: number[],
  period: number = 20,
  stdDevMultiplier: number = 2
): BollingerSeries {
  const middle = sma(values, period);
  const upper: number[] = new Array(values.length).fill(NaN);
  const lower: number[] = new Array(values.length).fill(NaN);

  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1);
    const std = stdDev(slice);
    
    upper[i] = middle[i] + std * stdDevMultiplier;
    lower[i] = middle[i] - std * stdDevMultiplier;
  }

  return {
    upper,
    middle,
    lower,
  };
}
