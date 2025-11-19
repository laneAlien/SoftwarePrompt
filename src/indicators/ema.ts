export function ema(values: number[], period: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  
  if (values.length < period) {
    return result;
  }

  const multiplier = 2 / (period + 1);

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  result[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    result[i] = (values[i] - result[i - 1]) * multiplier + result[i - 1];
  }

  return result;
}
