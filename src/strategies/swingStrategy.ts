import { IStrategy } from './baseStrategy';
import { StrategyContext, StrategySignal } from '../core/types';

export class SwingStrategy implements IStrategy {
  name = 'Swing';

  supportsTimeframe(timeframe: string): boolean {
    return ['4h', '1d'].includes(timeframe.toLowerCase());
  }

  generateSignal(ctx: StrategyContext): StrategySignal {
    const { indicators, currentPrice } = ctx;

    let action: 'buy' | 'sell' | 'hold' = 'hold';
    let strength: 'weak' | 'medium' | 'strong' = 'weak';
    let confidence = 0.3;
    let reason = 'No clear swing signal';

    if (!indicators.rsi || !indicators.bollinger || !indicators.macd) {
      return { strategyName: this.name, action, strength, confidence, reason };
    }

    const rsi = indicators.rsi;
    const bollinger = indicators.bollinger;
    const macd = indicators.macd;

    const oversold = rsi < 35;
    const overbought = rsi > 65;
    const nearLowerBB = currentPrice < bollinger.middle;
    const nearUpperBB = currentPrice > bollinger.middle;
    const macdPositive = macd.macd > 0;
    const macdNegative = macd.macd < 0;

    if (oversold && nearLowerBB && macdPositive) {
      action = 'buy';
      strength = 'strong';
      confidence = 0.75;
      reason = `Strong mean reversion signal: RSI ${rsi.toFixed(1)}, price below middle BB, MACD positive`;
    } else if (overbought && nearUpperBB && macdNegative) {
      action = 'sell';
      strength = 'strong';
      confidence = 0.75;
      reason = `Strong reversal signal: RSI ${rsi.toFixed(1)}, price above middle BB, MACD negative`;
    } else if (oversold && nearLowerBB) {
      action = 'buy';
      strength = 'medium';
      confidence = 0.6;
      reason = `Mean reversion: oversold RSI near lower BB`;
    } else if (overbought && nearUpperBB) {
      action = 'sell';
      strength = 'medium';
      confidence = 0.6;
      reason = `Mean reversion: overbought RSI near upper BB`;
    } else if (rsi > 45 && rsi < 55 && macd.histogram > 0 && nearLowerBB) {
      action = 'buy';
      strength = 'weak';
      confidence = 0.45;
      reason = 'Neutral RSI with positive MACD momentum';
    } else if (rsi > 45 && rsi < 55 && macd.histogram < 0 && nearUpperBB) {
      action = 'sell';
      strength = 'weak';
      confidence = 0.45;
      reason = 'Neutral RSI with negative MACD momentum';
    }

    if (ctx.reportSummary) {
      const { totalProfit, totalSpent, totalVoucherIncome } = ctx.reportSummary;
      if (totalProfit < 0) {
        confidence *= 0.8;
        reason += ' | Swing bias trimmed due to negative report PnL';
      }
      if (totalSpent > totalVoucherIncome && action === 'buy') {
        action = 'hold';
        reason += ' | Spending exceeds voucher income; holding back entries';
      }
    }

    return { strategyName: this.name, action, strength, confidence, reason };
  }
}
