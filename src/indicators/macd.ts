import { ema } from './ema';

export interface MacdSeries {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(
  values: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): MacdSeries {
  const emaFast = ema(values, fastPeriod);
  const emaSlow = ema(values, slowPeriod);

  const macdLine: number[] = new Array(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    if (!isNaN(emaFast[i]) && !isNaN(emaSlow[i])) {
      macdLine[i] = emaFast[i] - emaSlow[i];
    }
  }

  const validMacdValues: number[] = [];
  let firstValidIndex = -1;
  for (let i = 0; i < macdLine.length; i++) {
    if (!isNaN(macdLine[i])) {
      if (firstValidIndex === -1) firstValidIndex = i;
      validMacdValues.push(macdLine[i]);
    }
  }

  const signalEma = ema(validMacdValues, signalPeriod);
  
  const signalLine: number[] = new Array(values.length).fill(NaN);
  for (let i = 0; i < signalEma.length; i++) {
    signalLine[firstValidIndex + i] = signalEma[i];
  }

  const histogram: number[] = new Array(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    if (!isNaN(macdLine[i]) && !isNaN(signalLine[i])) {
      histogram[i] = macdLine[i] - signalLine[i];
    }
  }

  return {
    macd: macdLine,
    signal: signalLine,
    histogram: histogram,
  };
}
