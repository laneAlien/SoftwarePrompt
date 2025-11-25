import { Candle, RiskLevel } from '../core/types';

export interface RiskMetrics {
  maxDrawdownPercent: number;
  volatility: number;
}

export function calculateMaxDrawdown(candles: Candle[]): number {
  if (!candles.length) return 0;
  let peak = candles[0].close;
  let maxDrop = 0;
  for (const candle of candles) {
    peak = Math.max(peak, candle.close);
    const drop = ((peak - candle.close) / peak) * 100;
    if (drop > maxDrop) {
      maxDrop = drop;
    }
  }
  return maxDrop;
}

export function estimateVolatility(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const curr = candles[i].close;
    returns.push(Math.log(curr / prev));
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance =
    returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / Math.max(1, returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(returns.length);
}

export function determineRiskLevelFromMetrics(metrics: RiskMetrics): RiskLevel {
  if (metrics.maxDrawdownPercent > 40 || metrics.volatility > 0.25) return 'extreme';
  if (metrics.maxDrawdownPercent > 25 || metrics.volatility > 0.18) return 'high';
  if (metrics.maxDrawdownPercent > 10 || metrics.volatility > 0.1) return 'medium';
  return 'low';
}

export function adjustAggressiveness(baseAggressiveness: number, metrics: RiskMetrics, fundingRate?: number) {
  let factor = baseAggressiveness;
  if (metrics.maxDrawdownPercent > 20) {
    factor *= 0.8;
  }
  if (typeof fundingRate === 'number' && Math.abs(fundingRate) > 0.002) {
    factor *= fundingRate > 0 ? 0.9 : 1.05;
  }
  return Math.max(0.4, Math.min(2.0, factor));
}
