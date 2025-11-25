import { IStrategy } from './baseStrategy';
import { StrategyContext, StrategySignal } from '../core/types';

function averagePrice(candles: { close: number }[]): number {
  if (!candles.length) return 0;
  return candles.reduce((acc, c) => acc + c.close, 0) / candles.length;
}

export class MultiTimeframeStrategy implements IStrategy {
  name = 'Multi-Timeframe';

  supportsTimeframe(): boolean {
    return true;
  }

  generateSignal(ctx: StrategyContext): StrategySignal {
    const { candles, currentPrice } = ctx;
    let action: 'buy' | 'sell' | 'hold' = 'hold';
    let strength: 'weak' | 'medium' | 'strong' = 'weak';
    let confidence = 0.3;
    let reason = 'Multi-timeframe consensus neutral';

    const midWindow = candles.slice(-30);
    const shortWindow = candles.slice(-10);
    const longWindow = candles.slice(-90);

    const shortAvg = averagePrice(shortWindow);
    const midAvg = averagePrice(midWindow);
    const longAvg = averagePrice(longWindow);

    if (shortAvg > midAvg && midAvg > longAvg && currentPrice > shortAvg) {
      action = 'buy';
      strength = 'medium';
      confidence = 0.55;
      reason = 'Short/medium/long trends aligned upward';
    } else if (shortAvg < midAvg && midAvg < longAvg && currentPrice < shortAvg) {
      action = 'sell';
      strength = 'medium';
      confidence = 0.55;
      reason = 'Short/medium/long trends aligned downward';
    }

    if (ctx.reportSummary) {
      const { totalProfit, totalSpent, totalVoucherIncome } = ctx.reportSummary;
      if (totalProfit < 0) {
        confidence *= 0.8;
        reason += ' | Confidence trimmed by external losses';
      }
      if (totalSpent > totalVoucherIncome && action === 'buy') {
        action = 'hold';
        reason += ' | Expense imbalance discourages fresh longs';
      }
    }

    return { strategyName: this.name, action, strength, confidence, reason };
  }
}

