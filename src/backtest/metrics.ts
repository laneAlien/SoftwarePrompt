export interface PerformanceMetrics {
  maxDrawdown: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  expectancy: number;
}

function equityDeltas(equity: number[]): number[] {
  if (equity.length < 2) return [];
  const deltas: number[] = [];
  for (let i = 1; i < equity.length; i += 1) {
    deltas.push(equity[i] - equity[i - 1]);
  }
  return deltas;
}

export function equityCurve(initialBalance: number, deltas: number[]): number[] {
  const curve: number[] = [];
  let equity = initialBalance;
  for (const delta of deltas) {
    equity += delta;
    curve.push(equity);
  }
  return curve;
}

export function maxDrawdown(equity: number[]): number {
  if (!equity.length) return 0;
  let peak = equity[0];
  let maxDrawdownValue = 0;
  for (const value of equity) {
    if (value > peak) peak = value;
    const drawdown = peak > 0 ? (peak - value) / peak : 0;
    if (drawdown > maxDrawdownValue) {
      maxDrawdownValue = drawdown;
    }
  }
  return maxDrawdownValue;
}

export function winrate(equity: number[]): number {
  const deltas = equityDeltas(equity).filter((delta) => delta !== 0);
  if (!deltas.length) return 0;
  const wins = deltas.filter((delta) => delta > 0).length;
  const losses = deltas.length - wins;
  return wins + losses > 0 ? wins / (wins + losses) : 0;
}

export function avgWin(equity: number[]): number {
  const wins = equityDeltas(equity).filter((delta) => delta > 0);
  if (!wins.length) return 0;
  return wins.reduce((sum, value) => sum + value, 0) / wins.length;
}

export function avgLoss(equity: number[]): number {
  const losses = equityDeltas(equity).filter((delta) => delta < 0);
  if (!losses.length) return 0;
  const total = losses.reduce((sum, value) => sum + Math.abs(value), 0);
  return total / losses.length;
}

export function profitFactor(equity: number[]): number {
  const deltas = equityDeltas(equity);
  const grossProfit = deltas.filter((delta) => delta > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = deltas.filter((delta) => delta < 0).reduce((sum, value) => sum + Math.abs(value), 0);
  if (grossLoss === 0) {
    return grossProfit > 0 ? Number.POSITIVE_INFINITY : 0;
  }
  return grossProfit / grossLoss;
}

export function expectancy(equity: number[]): number {
  const winRateValue = winrate(equity);
  const lossRate = 1 - winRateValue;
  const avgWinValue = avgWin(equity);
  const avgLossValue = avgLoss(equity);
  return winRateValue * avgWinValue - lossRate * avgLossValue;
}

export function buildPerformanceMetrics(equity: number[]): PerformanceMetrics {
  return {
    maxDrawdown: maxDrawdown(equity),
    winRate: winrate(equity),
    avgWin: avgWin(equity),
    avgLoss: avgLoss(equity),
    profitFactor: profitFactor(equity),
    expectancy: expectancy(equity),
  };
}
