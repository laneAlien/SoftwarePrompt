import { IStrategy } from './baseStrategy';
import { StrategyContext, StrategySignal } from '../core/types';

export class IntradayStrategy implements IStrategy {
  name = 'Intraday';

  supportsTimeframe(timeframe: string): boolean {
    return ['15m', '30m', '1h'].includes(timeframe.toLowerCase());
  }

  generateSignal(ctx: StrategyContext): StrategySignal {
    const { indicators } = ctx;

    let action: 'buy' | 'sell' | 'hold' = 'hold';
    let strength: 'weak' | 'medium' | 'strong' = 'weak';
    let confidence = 0.3;
    let reason = 'No clear intraday signal';

    if (!indicators.macd || !indicators.emaFast || !indicators.emaSlow) {
      return { strategyName: this.name, action, strength, confidence, reason };
    }

    const macd = indicators.macd;
    const emaFast = indicators.emaFast;
    const emaSlow = indicators.emaSlow;

    const macdBullish = macd.macd > macd.signal && macd.histogram > 0;
    const macdBearish = macd.macd < macd.signal && macd.histogram < 0;
    const emaBullish = emaFast > emaSlow;
    const emaBearish = emaFast < emaSlow;

    if (macdBullish && emaBullish) {
      action = 'buy';
      strength = 'medium';
      confidence = 0.65;
      reason = 'MACD bullish crossover with EMA fast > slow';
    } else if (macdBearish && emaBearish) {
      action = 'sell';
      strength = 'medium';
      confidence = 0.65;
      reason = 'MACD bearish crossover with EMA fast < slow';
    } else if (macdBullish && !emaBullish) {
      action = 'buy';
      strength = 'weak';
      confidence = 0.4;
      reason = 'MACD bullish but EMA shows weakness';
    } else if (macdBearish && !emaBearish) {
      action = 'sell';
      strength = 'weak';
      confidence = 0.4;
      reason = 'MACD bearish but EMA shows strength';
    } else if (emaBullish && macd.macd > 0) {
      action = 'buy';
      strength = 'weak';
      confidence = 0.35;
      reason = 'Moderate bullish trend (EMA + MACD positive)';
    } else if (emaBearish && macd.macd < 0) {
      action = 'sell';
      strength = 'weak';
      confidence = 0.35;
      reason = 'Moderate bearish trend (EMA + MACD negative)';
    }

    if (ctx.reportSummary) {
      const { totalProfit, totalSpent, totalVoucherIncome } = ctx.reportSummary;
      if (totalProfit < 0) {
        confidence *= 0.8;
        reason += ' | Negative profit in external report';
      }
      if (totalSpent > totalVoucherIncome && action === 'buy') {
        action = 'hold';
        reason += ' | Elevated spend vs voucher income; skipping buys';
      }
    }

    return { strategyName: this.name, action, strength, confidence, reason };
  }
}
