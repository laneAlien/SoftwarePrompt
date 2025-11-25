import { IStrategy } from './baseStrategy';
import { StrategyContext, StrategySignal } from '../core/types';
import { fundingRiskScore } from '../indicators';

export class FundingStrategy implements IStrategy {
  name = 'Funding';

  supportsTimeframe(): boolean {
    return true;
  }

  generateSignal(ctx: StrategyContext): StrategySignal {
    const { indicators } = ctx;
    let action: 'buy' | 'sell' | 'hold' = 'hold';
    let strength: 'weak' | 'medium' | 'strong' = 'weak';
    let confidence = 0.3;
    let reason = 'No funding data available';

    const fundingRate = (indicators as any).fundingRate as number | undefined;
    if (typeof fundingRate === 'number') {
      const riskScore = fundingRiskScore(fundingRate);
      if (Math.abs(fundingRate) > 0.0015) {
        action = fundingRate > 0 ? 'sell' : 'buy';
        strength = 'medium';
        confidence = 0.55;
        reason = `Funding rate ${fundingRate} suggests contrarian tilt (risk ${riskScore})`;
      } else {
        action = 'hold';
        confidence = 0.35;
        reason = `Funding rate ${fundingRate} is moderate; stay neutral`;
      }
    }

    if (ctx.reportSummary) {
      const { totalProfit, totalSpent, totalVoucherIncome } = ctx.reportSummary;
      if (totalProfit < 0) {
        confidence *= 0.8;
        reason += ' | Reduced for negative financial report';
      }
      if (totalSpent > totalVoucherIncome && action === 'buy') {
        action = 'hold';
        reason += ' | Expense pressure: avoiding positive carry longs';
      }
    }

    return { strategyName: this.name, action, strength, confidence, reason };
  }
}

