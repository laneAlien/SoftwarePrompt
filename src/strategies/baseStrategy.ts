import { StrategyContext, StrategySignal } from '../core/types';

export interface IStrategy {
  name: string;
  supportsTimeframe(timeframe: string): boolean;
  generateSignal(ctx: StrategyContext): StrategySignal;
}
