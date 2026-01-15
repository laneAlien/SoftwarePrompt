import { MarketSimulator } from './marketSimulator';
import { OrderExecutionEngine } from './orderExecution';
import { SimulationReport, buildSimulationReport } from './reporter';
import { computeIndicators } from '../indicators';
import { detectRegime, MarketRegime } from '../core/regime';
import { Candle, RiskLevel } from '../core/types';
import { ReportSummary } from '../reports/reportParser';
import { determineRiskLevel } from '../real/liquidationRisk';
import { adjustAggressiveness, calculateMaxDrawdown, estimateVolatility } from '../real/riskManagement';
import { generateSignal, SignalResult } from '../strategies/signals';
import { computeFeatures } from '../ta/features';

export interface TradeBotConfig {
  symbol: string;
  timeframe: string;
  initialBalanceUsd: number;
  maxLeverage: number;
  mmr: number;
  historyWindow: number;
  aggressiveness: number;
  strategy: 'trend' | 'mean' | 'auto';
  minConfidence: number;
  cooldownBars: number;
  logNoTrade: boolean;
  reportSummary?: ReportSummary;
}

interface RiskValidationResult {
  ok: boolean;
  rejectReason?: string;
}

interface ExecutionResult {
  action: 'open-long' | 'open-short' | 'close' | 'hold';
  reason: string;
  feePaid?: number;
  pnl?: number;
}

export class TradeBot {
  private config: TradeBotConfig;
  private simulator: MarketSimulator;
  private execution: OrderExecutionEngine;
  private log: string[] = [];
  private tradesCount = 0;
  private liquidationsCount = 0;
  private closedTrades = 0;
  private winningTrades = 0;
  private maxDrawdownPercent = 0;
  private peakBalance: number;
  private dynamicAggressiveness: number;
  private lastTradeStep: number | null = null;
  private totalFeesPaid = 0;
  private noTradeReasons = new Map<string, number>();
  private lastNoTradeReason = '';
  private noTradeLogEvery = 25;

  constructor(config: TradeBotConfig, simulator: MarketSimulator, execution: OrderExecutionEngine) {
    this.config = config;
    this.simulator = simulator;
    this.execution = execution;
    this.peakBalance = config.initialBalanceUsd;
    this.dynamicAggressiveness = config.aggressiveness;
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
      const taFeatures = computeFeatures(marketState.recentCandles);
      const regime = detectRegime(marketState.recentCandles).regime;
      const signal = this.generateSignal(marketState.recentCandles, taFeatures, regime);

      const metrics = {
        maxDrawdownPercent: calculateMaxDrawdown(marketState.recentCandles),
        volatility: estimateVolatility(marketState.recentCandles),
      };
      this.dynamicAggressiveness = adjustAggressiveness(
        this.config.aggressiveness,
        metrics,
        indicators.fundingRate
      );

      const riskSnapshot = this.assessRisk(marketState.currentPrice);

      const validation = this.validateSignal(signal, riskSnapshot.riskLevel, stepCount);
      if (!validation.ok) {
        this.recordNoTrade(validation.rejectReason ?? 'Signal rejected', stepCount);
      } else {
        const execution = this.applySignal(signal, marketState.currentPrice, stepCount, riskSnapshot.riskLevel);
        if (execution.action === 'hold') {
          this.recordNoTrade(execution.reason, stepCount);
        } else if (execution.feePaid) {
          this.totalFeesPaid += execution.feePaid;
        }
      }

      this.updateMetrics(marketState.currentPrice);

      if (stepCount % 100 === 0) {
        const balance = this.execution.getTotalEquity(marketState.currentPrice);
        this.log.push(`[Step ${stepCount}] Price: $${marketState.currentPrice.toFixed(2)}, Balance: $${balance.toFixed(2)}`);
      }
    }

    const finalBalance = this.execution.getBalance();
    
    this.log.push('');
    this.log.push('Simulation completed.');

    const winRatePercent = this.closedTrades > 0 ? (this.winningTrades / this.closedTrades) * 100 : 0;
    const topNoTradeReasons = [...this.noTradeReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));

    return buildSimulationReport(
      this.config.initialBalanceUsd,
      finalBalance,
      this.tradesCount,
      winRatePercent,
      this.liquidationsCount,
      this.maxDrawdownPercent,
      this.totalFeesPaid,
      topNoTradeReasons,
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

  private getSizeFraction(): number {
    const baseSize = 0.08;
    const adjustment = (this.dynamicAggressiveness - 1) * 0.05;
    return Math.min(0.25, Math.max(0.02, baseSize + adjustment));
  }

  private getLeverage(): number {
    const baseLeverage = 1 + (this.dynamicAggressiveness - 1) * 1.5;
    return Math.min(this.config.maxLeverage, Math.max(1, baseLeverage));
  }

  private generateSignal(
    candles: Candle[],
    taFeatures: ReturnType<typeof computeFeatures>,
    regime: MarketRegime
  ): SignalResult {
    return generateSignal(candles, { ta: taFeatures, regime }, { strategy: this.config.strategy });
  }

  private validateSignal(signal: SignalResult, riskLevel: RiskLevel, stepCount: number): RiskValidationResult {
    if (riskLevel === 'extreme' && this.execution.getActivePositions().length > 0) {
      return {
        ok: true,
      };
    }

    if (signal.action === 'HOLD') {
      return { ok: false, rejectReason: signal.reason };
    }

    if (signal.confidence < this.config.minConfidence) {
      return {
        ok: false,
        rejectReason: `Confidence ${signal.confidence.toFixed(2)} below minimum ${this.config.minConfidence.toFixed(2)}`,
      };
    }

    if (this.lastTradeStep !== null && stepCount - this.lastTradeStep < this.config.cooldownBars) {
      return {
        ok: false,
        rejectReason: `Cooldown active (${this.config.cooldownBars} bars)`,
      };
    }

    const positions = this.execution.getActivePositions();
    if (positions.length > 0) {
      const position = positions[0];
      if (signal.action === 'BUY' && position.side === 'long') {
        return { ok: false, rejectReason: 'Already in long position' };
      }
      if (signal.action === 'SELL' && position.side === 'short') {
        return { ok: false, rejectReason: 'Already in short position' };
      }
    }

    return { ok: true };
  }

  private applySignal(
    signal: SignalResult,
    currentPrice: number,
    stepCount: number,
    riskLevel: RiskLevel
  ): ExecutionResult {
    try {
      const positions = this.execution.getActivePositions();
      if (riskLevel === 'extreme' && positions.length > 0) {
        const notional = positions[0].size * currentPrice;
        const feeRate = 0.0004;
        const feePaid = notional * feeRate;
        const pnl = this.execution.closePosition(0, currentPrice);
        this.execution.applyFee(feePaid);
        this.closedTrades += 1;
        if (pnl > 0) {
          this.winningTrades += 1;
        }
        this.lastTradeStep = stepCount;
        this.log.push(
          `[Step ${stepCount}] CLOSE | Price: $${currentPrice.toFixed(2)} | Reason: Emergency close due to extreme liquidation risk`
        );
        return { action: 'close', reason: 'Emergency close due to extreme liquidation risk', pnl, feePaid };
      }

      if (signal.action === 'HOLD') {
        return { action: 'hold', reason: signal.reason };
      }

      if (positions.length > 0) {
        const position = positions[0];
        const shouldClose =
          (signal.action === 'BUY' && position.side === 'short') ||
          (signal.action === 'SELL' && position.side === 'long');
        if (shouldClose) {
          const notional = position.size * currentPrice;
          const feeRate = 0.0004;
          const feePaid = notional * feeRate;
          const pnl = this.execution.closePosition(0, currentPrice);
          this.execution.applyFee(feePaid);
          this.closedTrades += 1;
          if (pnl > 0) {
            this.winningTrades += 1;
          }
          this.lastTradeStep = stepCount;
          this.log.push(
            `[Step ${stepCount}] CLOSE | Price: $${currentPrice.toFixed(2)} | Reason: ${signal.reason}`
          );
          return { action: 'close', reason: signal.reason, pnl, feePaid };
        }
        return { action: 'hold', reason: 'Holding existing position' };
      }

      const side = signal.action === 'BUY' ? 'long' : 'short';
      const sizeFraction = this.getSizeFraction();
      const leverage = this.getLeverage();

      const availableBalance = this.execution.getBalance();
      const margin = availableBalance * sizeFraction;
      const notional = margin * leverage;
      const size = notional / currentPrice;
      const feeRate = 0.0004;
      const feePaid = notional * feeRate;

      this.execution.openPosition(side, currentPrice, size, leverage, this.config.mmr);
      this.execution.applyFee(feePaid);
      this.tradesCount += 1;
      this.lastTradeStep = stepCount;

      this.log.push(
        `[Step ${stepCount}] OPEN ${side.toUpperCase()} | Price: $${currentPrice.toFixed(2)} | Size: ${size.toFixed(
          4
        )} | Leverage: ${leverage}x | Reason: ${signal.reason}`
      );

      return { action: side === 'long' ? 'open-long' : 'open-short', reason: signal.reason, feePaid };
    } catch (error) {
      this.log.push(`[Step ${stepCount}] ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { action: 'hold', reason: 'Execution error' };
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

  private recordNoTrade(reason: string, stepCount: number): void {
    if (!reason) return;
    const normalized = reason.trim();
    this.noTradeReasons.set(normalized, (this.noTradeReasons.get(normalized) ?? 0) + 1);

    if (!this.config.logNoTrade) return;
    const shouldLog =
      stepCount % this.noTradeLogEvery === 0 || normalized !== this.lastNoTradeReason;
    if (shouldLog) {
      this.log.push(`[Step ${stepCount}] NO-TRADE | ${normalized}`);
      this.lastNoTradeReason = normalized;
    }
  }
}
