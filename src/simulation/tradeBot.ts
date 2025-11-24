import { MarketSimulator } from './marketSimulator';
import { OrderExecutionEngine } from './orderExecution';
import { SimulationReport, buildSimulationReport } from './reporter';
import { computeIndicators } from '../indicators';
import { runAllStrategies, combineSignals } from '../strategies';
import { LlmClient, RiskLevel, StrategyContext, CombinedSignal } from '../core/types';
import { determineRiskLevel } from '../real/liquidationRisk';

export interface TradeBotConfig {
  symbol: string;
  timeframe: string;
  initialBalanceUsd: number;
  maxLeverage: number;
  mmr: number;
  historyWindow: number;
  aggressiveness: number;
}

export interface SimulationTradeDecision {
  action: 'open-long' | 'open-short' | 'close' | 'hold';
  sizeFraction?: number;
  leverage?: number;
  reason: string;
}

export class TradeBot {
  private config: TradeBotConfig;
  private simulator: MarketSimulator;
  private execution: OrderExecutionEngine;
  private llmClient?: LlmClient;
  private log: string[] = [];
  private tradesCount = 0;
  private liquidationsCount = 0;
  private maxDrawdownPercent = 0;
  private peakBalance: number;

  constructor(
    config: TradeBotConfig,
    simulator: MarketSimulator,
    execution: OrderExecutionEngine,
    llmClient?: LlmClient
  ) {
    this.config = config;
    this.simulator = simulator;
    this.execution = execution;
    this.llmClient = llmClient;
    this.peakBalance = config.initialBalanceUsd;
  }

  async runSimulation(): Promise<SimulationReport> {
    this.log.push(`Starting simulation for ${this.config.symbol} on ${this.config.timeframe}`);
    this.log.push(`Initial balance: $${this.config.initialBalanceUsd.toFixed(2)}`);
    this.log.push('');

    let stepCount = 0;

    while (this.simulator.hasNext()) {
      stepCount++;
      
      const marketState = this.simulator.next();
      this.execution.onPriceUpdate(marketState.currentPrice);

      const indicators = computeIndicators(marketState.recentCandles);

      const strategyContext: StrategyContext = {
        symbol: marketState.symbol,
        timeframe: marketState.timeframe,
        candles: marketState.recentCandles,
        indicators,
        currentPrice: marketState.currentPrice,
        position: null,
      };

      const signals = runAllStrategies(strategyContext);
      const combinedSignal = combineSignals(signals);

      const riskSnapshot = this.assessRisk(marketState.currentPrice);

      const decision = this.makeDecision(
        combinedSignal,
        riskSnapshot.riskLevel,
        marketState.currentPrice
      );

      await this.executeDecision(decision, marketState.currentPrice, stepCount);

      this.updateMetrics(marketState.currentPrice);

      if (stepCount % 100 === 0) {
        const balance = this.execution.getTotalEquity(marketState.currentPrice);
        this.log.push(`[Step ${stepCount}] Price: $${marketState.currentPrice.toFixed(2)}, Balance: $${balance.toFixed(2)}`);
      }
    }

    const finalBalance = this.execution.getBalance();
    
    this.log.push('');
    this.log.push('Simulation completed.');

    return buildSimulationReport(
      this.config.initialBalanceUsd,
      finalBalance,
      this.tradesCount,
      this.liquidationsCount,
      this.maxDrawdownPercent,
      this.log
    );
  }

  private assessRisk(currentPrice: number): { riskLevel: RiskLevel } {
    const positions = this.execution.getActivePositions();
    
    if (positions.length === 0) {
      return { riskLevel: 'low' };
    }

    let worstRiskLevel: RiskLevel = 'low';

    for (const position of positions) {
      if (!position.liquidationPrice) continue;

      const distancePercent = position.side === 'long'
        ? ((currentPrice - position.liquidationPrice) / currentPrice) * 100
        : ((position.liquidationPrice - currentPrice) / currentPrice) * 100;

      const riskLevel = determineRiskLevel(distancePercent, position.leverage);

      if (this.getRiskValue(riskLevel) > this.getRiskValue(worstRiskLevel)) {
        worstRiskLevel = riskLevel;
      }
    }

    return { riskLevel: worstRiskLevel };
  }

  private getRiskValue(level: RiskLevel): number {
    const map: Record<RiskLevel, number> = {
      low: 1,
      medium: 2,
      high: 3,
      extreme: 4,
    };
    return map[level];
  }

  private getOpenThreshold(): number {
    const baseThreshold = 0.65;
    const adjustment = (this.config.aggressiveness - 1) * 0.2;
    return Math.max(0.35, baseThreshold - adjustment);
  }

  private getSizeFraction(): number {
    const baseSize = 0.08;
    const adjustment = (this.config.aggressiveness - 1) * 0.05;
    return Math.min(0.25, Math.max(0.02, baseSize + adjustment));
  }

  private getLeverage(): number {
    const baseLeverage = 1 + (this.config.aggressiveness - 1) * 1.5;
    return Math.min(this.config.maxLeverage, Math.max(1, baseLeverage));
  }

  private makeDecision(
    combinedSignal: CombinedSignal,
    riskLevel: RiskLevel,
    currentPrice: number
  ): SimulationTradeDecision {
    const positions = this.execution.getActivePositions();

    if (riskLevel === 'extreme' && positions.length > 0) {
      return {
        action: 'close',
        reason: 'Emergency close due to extreme liquidation risk',
      };
    }

    if (positions.length > 0) {
      const position = positions[0];

      const closeThreshold = this.getOpenThreshold() * 0.7;
      const shouldClose =
        (position.side === 'long' && combinedSignal.scoreSell - combinedSignal.scoreBuy > closeThreshold) ||
        (position.side === 'short' && combinedSignal.scoreBuy - combinedSignal.scoreSell > closeThreshold);

      if (shouldClose) {
        return {
          action: 'close',
          reason: `Closing ${position.side} position due to strengthening opposite signal`,
        };
      }

      return {
        action: 'hold',
        reason: 'Holding existing position',
      };
    }

    const openThreshold = this.getOpenThreshold();
    const longBias = combinedSignal.scoreBuy - combinedSignal.scoreSell;
    const shortBias = combinedSignal.scoreSell - combinedSignal.scoreBuy;
    const sizeFraction = this.getSizeFraction();
    const leverage = this.getLeverage();

    if (longBias > openThreshold) {
      return {
        action: 'open-long',
        sizeFraction,
        leverage,
        reason: `Buy bias ${longBias.toFixed(2)} (threshold ${openThreshold.toFixed(2)})`,
      };
    } else if (shortBias > openThreshold) {
      return {
        action: 'open-short',
        sizeFraction,
        leverage,
        reason: `Sell bias ${shortBias.toFixed(2)} (threshold ${openThreshold.toFixed(2)})`,
      };
    }

    return {
      action: 'hold',
      reason: 'No strong signal detected',
    };
  }

  private async executeDecision(
    decision: SimulationTradeDecision,
    currentPrice: number,
    stepCount: number
  ): Promise<void> {
    try {
      if (decision.action === 'open-long' || decision.action === 'open-short') {
        const side = decision.action === 'open-long' ? 'long' : 'short';
        const sizeFraction = decision.sizeFraction || 0.1;
        const leverage = decision.leverage || 2;

        const availableBalance = this.execution.getBalance();
        const margin = availableBalance * sizeFraction;
        const notional = margin * leverage;
        const size = notional / currentPrice;

        this.execution.openPosition(side, currentPrice, size, leverage, this.config.mmr);
        this.tradesCount++;

        this.log.push(
          `[Step ${stepCount}] OPEN ${side.toUpperCase()} | Price: $${currentPrice.toFixed(2)} | Size: ${size.toFixed(4)} | Leverage: ${leverage}x | Reason: ${decision.reason}`
        );
      } else if (decision.action === 'close') {
        const positions = this.execution.getActivePositions();
        if (positions.length > 0) {
          this.execution.closePosition(0, currentPrice);
          this.log.push(
            `[Step ${stepCount}] CLOSE | Price: $${currentPrice.toFixed(2)} | Reason: ${decision.reason}`
          );
        }
      }
    } catch (error) {
      this.log.push(`[Step ${stepCount}] ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private updateMetrics(currentPrice: number): void {
    const liquidatedPositions = this.execution.getPositions().filter((p) => p.isLiquidated);
    this.liquidationsCount = liquidatedPositions.length;

    const equity = this.execution.getTotalEquity(currentPrice);
    if (equity > this.peakBalance) {
      this.peakBalance = equity;
    }

    const drawdown = ((this.peakBalance - equity) / this.peakBalance) * 100;
    if (drawdown > this.maxDrawdownPercent) {
      this.maxDrawdownPercent = drawdown;
    }
  }
}
