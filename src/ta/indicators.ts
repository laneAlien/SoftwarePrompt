import { Candle } from '../core/types';

export const sma = (values: number[], length: number): number | null => {
  if (length <= 0 || values.length < length) return null;
  const slice = values.slice(values.length - length);
  const sum = slice.reduce((total, value) => total + value, 0);
  return sum / length;
};

export const ema = (values: number[], length: number): number | null => {
  if (length <= 0 || values.length < length) return null;
  const k = 2 / (length + 1);
  let emaValue = sma(values.slice(0, length), length) ?? values[length - 1];
  for (let i = length; i < values.length; i += 1) {
    emaValue = values[i] * k + emaValue * (1 - k);
  }
  return emaValue;
};

export const rsi = (values: number[], length: number): number | null => {
  if (length <= 0 || values.length < length + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / length;
  let avgLoss = losses / length;

  for (let i = length + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
};

export const atr = (candles: Candle[], length: number): number | null => {
  if (length <= 0 || candles.length < length + 1) return null;
  const ranges: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    const highLow = current.high - current.low;
    const highClose = Math.abs(current.high - previous.close);
    const lowClose = Math.abs(current.low - previous.close);
    ranges.push(Math.max(highLow, highClose, lowClose));
  }

  if (ranges.length < length) return null;
  let atrValue = ranges.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  for (let i = length; i < ranges.length; i += 1) {
    atrValue = (atrValue * (length - 1) + ranges[i]) / length;
  }
  return atrValue;
};

export const bollinger = (
  values: number[],
  length: number,
  stdDev = 2
): { upper: number; middle: number; lower: number } | null => {
  if (length <= 0 || values.length < length) return null;
  const slice = values.slice(values.length - length);
  const middle = slice.reduce((sum, value) => sum + value, 0) / length;
  const variance = slice.reduce((sum, value) => sum + (value - middle) ** 2, 0) / length;
  const deviation = Math.sqrt(variance);
  return {
    upper: middle + deviation * stdDev,
    middle,
    lower: middle - deviation * stdDev,
  };
};
