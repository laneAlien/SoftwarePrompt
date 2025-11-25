import { IStrategy } from './baseStrategy';
import { StrategyContext, StrategySignal } from '../core/types';

export class VolumeStrategy implements IStrategy {
  name = 'Volume';

  supportsTimeframe(): boolean {
    return true;
  }

  generateSignal(ctx: StrategyContext): StrategySignal {
    const { indicators, candles, currentPrice } = ctx;
    let action: 'buy' | 'sell' | 'hold' = 'hold';
    let strength: 'weak' | 'medium' | 'strong' = 'weak';
    let confidence = 0.3;
    let reason = 'Volume indicators neutral';

    if (!indicators.obv || !indicators.vwap) {
      return { strategyName: this.name, action, strength, confidence, reason };
    }

    const obvTrend = indicators.obv - (candles.length > 3 ? (candles[candles.length - 3].volume || 0) : 0);
    const priceVsVWAP = currentPrice / indicators.vwap;

    if (obvTrend > 0 && priceVsVWAP > 1.001) {
      action = 'buy';
      strength = priceVsVWAP > 1.01 ? 'strong' : 'medium';
      confidence = strength === 'strong' ? 0.7 : 0.5;
      reason = 'Positive OBV trend with price above VWAP';
    } else if (obvTrend < 0 && priceVsVWAP < 0.999) {
      action = 'sell';
      strength = priceVsVWAP < 0.99 ? 'strong' : 'medium';
      confidence = strength === 'strong' ? 0.7 : 0.5;
      reason = 'Negative OBV trend with price below VWAP';
    }

    if (ctx.reportSummary) {
      const { totalProfit, totalSpent, totalVoucherIncome } = ctx.reportSummary;
      if (totalProfit < 0) {
        confidence *= 0.8;
        reason += ' | Adjusted for negative external profitability';
      }
      if (totalSpent > totalVoucherIncome && action === 'buy') {
        action = 'hold';
        reason += ' | Expenses exceed voucher income; holding off buys';
      }
    }

    return { strategyName: this.name, action, strength, confidence, reason };
  }
}

