import { IStrategy } from './baseStrategy';
import { StrategyContext, StrategySignal } from '../core/types';

export class ScalpingStrategy implements IStrategy {
  name = 'Scalping';

  supportsTimeframe(timeframe: string): boolean {
    return ['1m', '3m', '5m'].includes(timeframe.toLowerCase());
  }

  generateSignal(ctx: StrategyContext): StrategySignal {
    const { indicators, currentPrice } = ctx;

    let action: 'buy' | 'sell' | 'hold' = 'hold';
    let strength: 'weak' | 'medium' | 'strong' = 'weak';
    let confidence = 0.3;
    let reason = 'No clear scalping signal';

    if (!indicators.rsi || !indicators.bollinger) {
      return { strategyName: this.name, action, strength, confidence, reason };
    }

    const rsi = indicators.rsi;
    const bollinger = indicators.bollinger;
    const lowerBand = bollinger.lower;
    const upperBand = bollinger.upper;

    if (rsi < 30 && currentPrice <= lowerBand * 1.005) {
      action = 'buy';
      strength = rsi < 25 ? 'medium' : 'weak';
      confidence = rsi < 25 ? 0.6 : 0.4;
      reason = `Oversold RSI (${rsi.toFixed(1)}) near lower Bollinger Band`;
    } else if (rsi > 70 && currentPrice >= upperBand * 0.995) {
      action = 'sell';
      strength = rsi > 75 ? 'medium' : 'weak';
      confidence = rsi > 75 ? 0.6 : 0.4;
      reason = `Overbought RSI (${rsi.toFixed(1)}) near upper Bollinger Band`;
    } else if (indicators.emaFast && indicators.emaSlow) {
      const emaFast = indicators.emaFast;
      const emaSlow = indicators.emaSlow;
      
      if (emaFast > emaSlow && currentPrice < bollinger.middle) {
        action = 'buy';
        strength = 'weak';
        confidence = 0.35;
        reason = 'EMA fast > slow with price below middle BB';
      } else if (emaFast < emaSlow && currentPrice > bollinger.middle) {
        action = 'sell';
        strength = 'weak';
        confidence = 0.35;
        reason = 'EMA fast < slow with price above middle BB';
      }
    }

    if (ctx.reportSummary) {
      const { totalProfit, totalSpent, totalVoucherIncome } = ctx.reportSummary;
      if (totalProfit < 0) {
        confidence *= 0.8;
        reason += ' | Confidence reduced due to negative external PnL';
      }
      if (totalSpent > totalVoucherIncome && action === 'buy') {
        action = 'hold';
        reason += ' | Spending outpaces voucher income; pausing new entries';
      }
    }

    return { strategyName: this.name, action, strength, confidence, reason };
  }
}
