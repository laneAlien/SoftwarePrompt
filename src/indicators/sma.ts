export function sma(values: number[], period: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  
  if (values.length < period) {
    return result;
  }

  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += values[i - j];
    }
    result[i] = sum / period;
  }

  return result;
}
