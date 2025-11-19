import { IStrategy } from './baseStrategy';
import { ScalpingStrategy } from './scalpingStrategy';
import { IntradayStrategy } from './intradayStrategy';
import { SwingStrategy } from './swingStrategy';
import { PositionStrategy } from './positionStrategy';
import { StrategyContext, StrategySignal, CombinedSignal } from '../core/types';

export * from './baseStrategy';
export * from './scalpingStrategy';
export * from './intradayStrategy';
export * from './swingStrategy';
export * from './positionStrategy';

const ALL_STRATEGIES: IStrategy[] = [
  new ScalpingStrategy(),
  new IntradayStrategy(),
  new SwingStrategy(),
  new PositionStrategy(),
];

export function runAllStrategies(ctx: StrategyContext): StrategySignal[] {
  const signals: StrategySignal[] = [];

  for (const strategy of ALL_STRATEGIES) {
    if (strategy.supportsTimeframe(ctx.timeframe)) {
      const signal = strategy.generateSignal(ctx);
      signals.push(signal);
    }
  }

  return signals;
}

export function combineSignals(signals: StrategySignal[]): CombinedSignal {
  let scoreBuy = 0;
  let scoreSell = 0;
  let scoreHold = 0;
  const reasons: string[] = [];

  for (const signal of signals) {
    reasons.push(`[${signal.strategyName}] ${signal.reason}`);

    if (signal.action === 'buy') {
      scoreBuy += signal.confidence;
    } else if (signal.action === 'sell') {
      scoreSell += signal.confidence;
    } else {
      scoreHold += signal.confidence;
    }
  }

  let action: 'buy' | 'sell' | 'hold' = 'hold';
  const maxScore = Math.max(scoreBuy, scoreSell, scoreHold);

  if (maxScore === scoreBuy && scoreBuy > 0.5) {
    action = 'buy';
  } else if (maxScore === scoreSell && scoreSell > 0.5) {
    action = 'sell';
  } else {
    action = 'hold';
  }

  return {
    action,
    scoreBuy,
    scoreSell,
    scoreHold,
    reasons,
  };
}
