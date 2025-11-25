export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timeframe: string;
  symbol?: string;
}

export interface MarketState {
  currentPrice: number;
  recentCandles: Candle[];
  symbol: string;
  timeframe: string;
}

export type PositionSide = 'long' | 'short';

export interface Position {
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  size: number;
  leverage: number;
  unrealizedPnl?: number;
  margin: number;
  liquidationPrice?: number;
  exchange: string;
}

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';

export interface Order {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price?: number;
  size: number;
  timestamp: number;
}

export type AssetType = 'spot' | 'futures' | 'margin' | 'staking';

export interface PortfolioAsset {
  symbol: string;
  amount: number;
  valueUsd?: number;
  type: AssetType;
  exchange?: string;
}

export interface ConcentrationMetrics {
  top1WeightPercent: number;
  top3WeightPercent: number;
  stablecoinsPercent: number;
  highRiskPercent: number;
}

export interface PortfolioSummary {
  totalValueUsd: number;
  assets: PortfolioAsset[];
  stablecoinsValueUsd: number;
  highRiskValueUsd: number;
  concentration: ConcentrationMetrics;
}

export type NewsType = 'news' | 'signal' | 'promo' | 'voucher' | 'onchain';
export type NewsSentiment = 'bullish' | 'bearish' | 'neutral' | 'mixed';

export interface NewsItem {
  id: string;
  symbol?: string;
  source: string;
  type: NewsType;
  sentiment: NewsSentiment;
  timestamp: number;
  title: string;
  summary: string;
  rawLink?: string;
}

export interface MacdValue {
  macd: number;
  signal: number;
  histogram: number;
}

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
}

export interface IndicatorSet {
  rsi?: number;
  macd?: MacdValue;
  emaFast?: number;
  emaSlow?: number;
  sma?: number;
  bollinger?: BollingerBands;
  obv?: number;
  vwap?: number;
}

export type StrategySignalStrength = 'weak' | 'medium' | 'strong';
export type StrategyActionType = 'buy' | 'sell' | 'hold';

export interface StrategySignal {
  strategyName: string;
  action: StrategyActionType;
  strength: StrategySignalStrength;
  confidence: number;
  reason: string;
}

export interface StrategyContext {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  indicators: IndicatorSet;
  currentPrice: number;
  position: Position | null;
  reportSummary?: import('../reports/reportParser').ReportSummary;
}

export interface CombinedSignal {
  action: StrategyActionType;
  scoreBuy: number;
  scoreSell: number;
  scoreHold: number;
  reasons: string[];
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'extreme';

export interface LeverageRiskResult {
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  notional: number;
  initialMargin: number;
  liquidationPrice: number | null;
  distanceToLiqPercent: number | null;
  marginUsagePercent: number;
  riskLevel: RiskLevel;
}

export interface RiskSnapshot {
  liquidationPrice: number | null;
  distanceToLiqPercent: number | null;
  marginUsagePercent: number;
  riskLevel: RiskLevel;
}

export type LlmMode = 'pair' | 'position' | 'portfolio' | 'news' | 'simulation';

export interface LlmAnalysisInput {
  symbol?: string;
  timeframe?: string;
  candles?: Candle[];
  indicators?: IndicatorSet;
  strategySignal?: CombinedSignal;
  positions?: Position[];
  portfolioSummary?: PortfolioSummary;
  news?: NewsItem[];
  riskSnapshot?: RiskSnapshot;
}

export interface LlmAnalysisOutput {
  summary: string;
  risks: string[];
  scenarios: {
    conservative: string;
    moderate: string;
    aggressive: string;
  };
  disclaimer: string;
}

export interface LlmClient {
  analyze(input: LlmAnalysisInput, mode: LlmMode): Promise<LlmAnalysisOutput>;
}
