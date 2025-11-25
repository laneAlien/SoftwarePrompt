import { IStrategy } from './baseStrategy';
import { StrategyContext, StrategySignal } from '../core/types';

export class PositionStrategy implements IStrategy {
  name = 'Position';

  supportsTimeframe(timeframe: string): boolean {
    return ['1d', '1w', '1M'].includes(timeframe.toLowerCase());
  }

  generateSignal(ctx: StrategyContext): StrategySignal {
    const { indicators } = ctx;

    let action: 'buy' | 'sell' | 'hold' = 'hold';
    let strength: 'weak' | 'medium' | 'strong' = 'weak';
    let confidence = 0.3;
    let reason = 'No clear long-term position signal';

    if (!indicators.rsi || !indicators.macd || !indicators.emaSlow) {
      return { strategyName: this.name, action, strength, confidence, reason };
    }

    const rsi = indicators.rsi;
    const macd = indicators.macd;

    const strongUptrend = macd.macd > 0 && macd.histogram > 0 && rsi >= 40 && rsi <= 60;
    const strongDowntrend = macd.macd < 0 && macd.histogram < 0 && rsi >= 40 && rsi <= 60;
    const overheated = rsi > 70;
    const oversold = rsi < 30;

    if (strongUptrend && !overheated) {
      action = 'buy';
      strength = 'medium';
      confidence = 0.6;
      reason = 'Sustained uptrend with healthy RSI (no overheating)';
    } else if (strongDowntrend && !oversold) {
      action = 'sell';
      strength = 'medium';
      confidence = 0.6;
      reason = 'Sustained downtrend with RSI confirmation';
    } else if (overheated) {
      action = 'sell';
      strength = 'weak';
      confidence = 0.4;
      reason = `Market overheated with RSI ${rsi.toFixed(1)} - risk of reversal`;
    } else if (oversold && macd.macd > 0) {
      action = 'buy';
      strength = 'weak';
      confidence = 0.45;
      reason = `Oversold with positive MACD - potential accumulation zone`;
    } else if (macd.macd > 0 && rsi > 50) {
      action = 'hold';
      strength = 'weak';
      confidence = 0.35;
      reason = 'Moderate positive momentum - hold existing positions';
    }

    if (ctx.reportSummary) {
      const { totalProfit, totalSpent, totalVoucherIncome } = ctx.reportSummary;
      if (totalProfit < 0) {
        confidence *= 0.8;
        reason += ' | Long-horizon signal tempered by external losses';
      }
      if (totalSpent > totalVoucherIncome && action === 'buy') {
        action = 'hold';
        reason += ' | Expense imbalance detected; pausing accumulation';
      }
    }

    return { strategyName: this.name, action, strength, confidence, reason };
  }
}
