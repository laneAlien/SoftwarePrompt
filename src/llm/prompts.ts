import { LlmAnalysisInput, LlmMode } from '../core/types';

export const BASE_SYSTEM_PROMPT = `You are a financial risk analyst and cryptocurrency market behavior expert.
You DO NOT give direct trading commands (don't say "buy", "sell", "short").
You assess the situation, describe risks and possible scenarios.
The final decision always remains with the user.
Always warn about leverage risks, liquidation, and high volatility.`;

export const PAIR_ANALYSIS_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

You analyze one trading pair on a specific timeframe.
You are given indicators (RSI, MACD, EMA, Bollinger Bands) and part of the price history.
You should:
- Characterize the current trend (bullish, bearish, sideways, uncertain)
- Assess overbought/oversold conditions
- Identify high-risk zones
- Describe what could happen with sharp price movements
Do not give direct "buy/sell" commands.`;

export const POSITION_ANALYSIS_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

You analyze a specific margin position with leverage.
Focus on:
- Distance to liquidation price
- Current risk level
- Potential scenarios (price moves up/down)
- Risk management recommendations
Explain the risks clearly but without creating panic.`;

export const PORTFOLIO_ANALYSIS_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

You analyze the entire cryptocurrency portfolio.
Focus on:
- Asset diversification
- Concentration risks (too much in one asset)
- Stablecoin balance
- High-risk asset exposure
Provide balanced risk assessment.`;

export const NEWS_ANALYSIS_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

You analyze news and signals about cryptocurrencies.
Focus on:
- Sentiment analysis
- Potential market impact
- Risk factors from news
Do not make trading recommendations based solely on news.`;

export const SIMULATION_ANALYSIS_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

You analyze simulation results of AI trading bot.
Focus on:
- Performance metrics
- Risk management quality
- Lessons learned
- Areas for improvement
This is educational analysis of simulated trading.`;

export function buildUserPromptForMode(
  input: LlmAnalysisInput,
  mode: LlmMode
): string {
  switch (mode) {
    case 'pair':
      return buildPairAnalysisPrompt(input);
    case 'position':
      return buildPositionAnalysisPrompt(input);
    case 'portfolio':
      return buildPortfolioAnalysisPrompt(input);
    case 'news':
      return buildNewsAnalysisPrompt(input);
    case 'simulation':
      return buildSimulationAnalysisPrompt(input);
    default:
      return 'Provide market analysis.';
  }
}

function buildPairAnalysisPrompt(input: LlmAnalysisInput): string {
  const parts = [
    `Symbol: ${input.symbol || 'N/A'}`,
    `Timeframe: ${input.timeframe || 'N/A'}`,
  ];

  if (input.candles && input.candles.length > 0) {
    const lastCandle = input.candles[input.candles.length - 1];
    parts.push(`Current Price: $${lastCandle.close.toFixed(2)}`);
  }

  if (input.indicators) {
    if (input.indicators.rsi !== undefined) {
      parts.push(`RSI: ${input.indicators.rsi.toFixed(1)}`);
    }
    if (input.indicators.macd) {
      parts.push(`MACD: ${input.indicators.macd.macd.toFixed(4)} | Signal: ${input.indicators.macd.signal.toFixed(4)}`);
    }
    if (input.indicators.emaFast && input.indicators.emaSlow) {
      parts.push(`EMA Fast: ${input.indicators.emaFast.toFixed(2)} | EMA Slow: ${input.indicators.emaSlow.toFixed(2)}`);
    }
    if (input.indicators.bollinger) {
      parts.push(`Bollinger: Upper ${input.indicators.bollinger.upper.toFixed(2)} | Middle ${input.indicators.bollinger.middle.toFixed(2)} | Lower ${input.indicators.bollinger.lower.toFixed(2)}`);
    }
  }

  if (input.strategySignal) {
    parts.push(`Strategy Signal: ${input.strategySignal.action} (Buy Score: ${input.strategySignal.scoreBuy.toFixed(2)}, Sell Score: ${input.strategySignal.scoreSell.toFixed(2)})`);
  }

  if (input.riskSnapshot) {
    parts.push(`Risk Level: ${input.riskSnapshot.riskLevel}`);
    if (input.riskSnapshot.distanceToLiqPercent) {
      parts.push(`Distance to Liquidation: ${input.riskSnapshot.distanceToLiqPercent.toFixed(2)}%`);
    }
  }

  parts.push('\nProvide a brief analysis of the current situation, key risks, and three scenarios (conservative, moderate, aggressive) for a trader. Do not give direct buy/sell commands.');

  return parts.join('\n');
}

function buildPositionAnalysisPrompt(input: LlmAnalysisInput): string {
  const parts = ['Position Analysis:'];

  if (input.positions && input.positions.length > 0) {
    const position = input.positions[0];
    parts.push(`Symbol: ${position.symbol}`);
    parts.push(`Side: ${position.side}`);
    parts.push(`Entry Price: $${position.entryPrice.toFixed(2)}`);
    parts.push(`Leverage: ${position.leverage}x`);
    if (position.liquidationPrice) {
      parts.push(`Liquidation Price: $${position.liquidationPrice.toFixed(2)}`);
    }
  }

  if (input.riskSnapshot) {
    parts.push(`Risk Level: ${input.riskSnapshot.riskLevel}`);
    if (input.riskSnapshot.distanceToLiqPercent) {
      parts.push(`Distance to Liquidation: ${input.riskSnapshot.distanceToLiqPercent.toFixed(2)}%`);
    }
  }

  parts.push('\nAnalyze the position risks and provide scenarios. No direct trading commands.');

  return parts.join('\n');
}

function buildPortfolioAnalysisPrompt(input: LlmAnalysisInput): string {
  const parts = ['Portfolio Analysis:'];

  if (input.portfolioSummary) {
    parts.push(`Total Value: $${input.portfolioSummary.totalValueUsd.toFixed(2)}`);
    parts.push(`Stablecoins: ${input.portfolioSummary.concentration.stablecoinsPercent.toFixed(1)}%`);
    parts.push(`High Risk Assets: ${input.portfolioSummary.concentration.highRiskPercent.toFixed(1)}%`);
    parts.push(`Top 1 Asset Concentration: ${input.portfolioSummary.concentration.top1WeightPercent.toFixed(1)}%`);
    parts.push(`Top 3 Assets Concentration: ${input.portfolioSummary.concentration.top3WeightPercent.toFixed(1)}%`);
  }

  parts.push('\nAnalyze portfolio diversification and risks.');

  return parts.join('\n');
}

function buildNewsAnalysisPrompt(input: LlmAnalysisInput): string {
  const parts = ['News & Signals Analysis:'];

  if (input.news && input.news.length > 0) {
    for (const item of input.news) {
      parts.push(`\n- [${item.type}] ${item.title} (Sentiment: ${item.sentiment})`);
      parts.push(`  ${item.summary}`);
    }
  }

  parts.push('\nAnalyze the overall sentiment and potential market impact.');

  return parts.join('\n');
}

function buildSimulationAnalysisPrompt(input: LlmAnalysisInput): string {
  return 'Analyze simulation results and provide insights on performance and risk management.';
}
