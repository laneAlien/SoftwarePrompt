export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, val) => sum + val, 0) / values.length;
}

export function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = mean(values);
  const squareDiffs = values.map((value) => Math.pow(value - avg, 2));
  return Math.sqrt(mean(squareDiffs));
}

export function normalizeTimeframe(timeframe: string): string {
  const normalized = timeframe.toLowerCase().trim();
  const validTimeframes = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'];
  
  if (validTimeframes.includes(normalized)) {
    return normalized;
  }
  
  return '15m';
}

export function parseTimeframeToMs(timeframe: string): number {
  const unit = timeframe.slice(-1);
  const value = parseInt(timeframe.slice(0, -1));
  
  switch (unit) {
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    case 'w':
      return value * 7 * 24 * 60 * 60 * 1000;
    case 'M':
      return value * 30 * 24 * 60 * 60 * 1000;
    default:
      return 15 * 60 * 1000;
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function formatNumber(value: number, decimals: number = 2): string {
  return value.toFixed(decimals);
}

export function formatPercentage(value: number, decimals: number = 2): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

export function formatUsd(value: number, decimals: number = 2): string {
  return `$${value.toFixed(decimals)}`;
}

export function isStablecoin(symbol: string): boolean {
  const stablecoins = ['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDD', 'FDUSD'];
  const upperSymbol = symbol.toUpperCase();
  return stablecoins.some((stable) => upperSymbol.includes(stable));
}

export function calculatePercentageChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) return 0;
  return ((newValue - oldValue) / oldValue) * 100;
}
