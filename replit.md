# Overview

The Crypto Trading AI Assistant is an educational TypeScript/Node.js application designed for cryptocurrency market analysis, simulation, and risk assessment. **This is explicitly NOT a real automated trading system** - it serves as an analytical and learning tool that combines technical analysis, AI-powered insights, and market simulation capabilities.

The system provides:
- Technical indicator calculations (RSI, MACD, EMA, SMA, Bollinger Bands)
- Multiple trading strategy frameworks (scalping, intraday, swing, position)
- Market simulation with artificial candle generation
- AI trading bot simulation (no real trading)
- Read-only integration with real exchanges (KuCoin, Gate.io)
- Portfolio analysis and risk management tools
- Optional LLM-powered market commentary
- CLI interface and basic Telegram bot framework

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Core Architecture

**Modular Design**: The application follows a strict separation of concerns with independent modules for indicators, strategies, simulation, real exchange integration, and UI layers. Core business logic is decoupled from presentation layers (CLI/Telegram).

**Type Safety**: Built with TypeScript in strict mode, enforcing comprehensive type definitions in `src/core/types.ts` for all data structures including candles, positions, orders, portfolio assets, and market states.

**No Real Trading**: Architecture enforces read-only exchange access through CCXT library. All trading actions occur within isolated simulation environment using `OrderExecutionEngine` class that manages virtual positions and balance.

## Technical Indicators Layer

**Pure Functions**: All indicators implemented as pure functions operating on arrays of price data without side effects. Located in `src/indicators/`.

**Implementations**:
- RSI (Relative Strength Index) with configurable periods
- EMA/SMA (Exponential/Simple Moving Averages)
- MACD (Moving Average Convergence Divergence)
- Bollinger Bands with standard deviation calculations

**Aggregation**: `computeIndicators()` function consolidates all indicator calculations and returns structured `IndicatorSet` containing current indicator values.

## Strategy Framework

**Interface-Based**: All strategies implement `IStrategy` interface with timeframe support checking and signal generation. Located in `src/strategies/`.

**Strategy Types**:
- Scalping (1m-5m timeframes): Focus on RSI and Bollinger Bands
- Intraday (15m-1h): MACD and EMA crossovers
- Swing (4h-1d): Mean reversion with multiple indicator confluence
- Position (1d+): Long-term trend analysis

**Signal Aggregation**: `combineSignals()` function scores and weights signals from multiple strategies, producing unified trading recommendations with confidence levels.

## Market Simulation Engine

**Candle Generation**: `candleGenerator.ts` creates artificial OHLCV data with configurable volatility, trend strength, and shock probability for testing strategies.

**State Machine**: `MarketSimulator` class iterates through candle data step-by-step, providing historical windows for indicator calculation.

**Position Management**: `OrderExecutionEngine` handles virtual position lifecycle including:
- Entry/exit execution
- PnL calculation
- Margin and leverage management
- Liquidation price monitoring
- Balance tracking

## AI Trading Bot

**Multi-Layer Decision Making**: `TradeBot` class orchestrates:
1. Market state retrieval
2. Indicator computation
3. Strategy signal generation
4. Risk assessment
5. Optional LLM analysis
6. Trade decision execution

**Risk-First Approach**: Bot checks liquidation risk and portfolio exposure before considering new positions, preventing overleveraged scenarios.

## Real Exchange Integration

**Read-Only CCXT Clients**: `KucoinClient` and `GateClient` classes wrap CCXT library for:
- Historical candle fetching
- Balance queries
- Current price retrieval
- NO order placement capabilities

**Portfolio Aggregation**: `portfolioAnalyzer.ts` consolidates holdings across multiple exchanges, calculates USD values, and generates concentration metrics.

**Risk Calculation**: `liquidationRisk.ts` provides mathematical functions for:
- Unrealized PnL computation
- Maintenance margin requirements
- Liquidation price estimation
- Distance-to-liquidation metrics

## LLM Integration Layer

**Optional Enhancement**: OpenAI integration through `OpenAILlmClient` class provides natural language market analysis commentary.

**Strict Boundaries**: LLM receives structured data (indicators, signals, positions) and returns textual explanations only. **LLM does NOT make trading decisions** - it provides analysis and scenario descriptions.

**Prompt Engineering**: Dedicated prompts in `src/llm/prompts.ts` for different analysis modes (pair analysis, position risk, portfolio overview, news sentiment).

**Graceful Degradation**: System functions fully without LLM - fallback responses provided if API unavailable.

## User Interface Layers

**CLI (Primary Interface)**: Commander.js-based CLI in `src/ui/cli.ts` with commands:
- `simulate`: Generate and analyze artificial market data
- `trade-sim`: Run AI bot simulation
- `analyze-pair`: Analyze real exchange data
- `analyze-portfolio`: Multi-exchange portfolio analysis
- `analyze-news`: Crypto news aggregation

**Telegram Bot (Stub)**: Basic framework in `src/ui/telegramBot.ts` using node-telegram-bot-api. Minimal implementation with start/help commands - directs users to CLI for full functionality.

## Data Flow

```
Real Exchange OR Simulation
    ↓
Candle Data
    ↓
Indicator Computation
    ↓
Strategy Signal Generation
    ↓
Signal Aggregation + Risk Assessment
    ↓
(Optional) LLM Analysis
    ↓
Decision Layer
    ↓
Execution (Simulation Only) OR Reporting
```

# External Dependencies

## Core Runtime Dependencies

- **Node.js Runtime**: JavaScript runtime environment
- **TypeScript**: Type-safe superset of JavaScript compiled to Node.js-compatible code

## Exchange & Market Data

- **CCXT (v4.2.0)**: Unified cryptocurrency exchange API library used for read-only access to KuCoin and Gate.io
  - Fetches OHLCV candle data
  - Queries account balances
  - Retrieves current market prices
  - **Note**: Configured for read-only operations only

## LLM Integration (Optional)

- **OpenAI SDK (v6.9.1)**: Official OpenAI client for GPT model access
  - Used for market analysis commentary
  - Scenario generation
  - Risk explanation
  - **Configuration**: Requires `OPENAI_API_KEY` environment variable
  - **Fallback**: System operates without LLM if not configured

## CLI & Bot Interfaces

- **Commander.js (v11.1.0)**: Command-line interface framework for parsing arguments and organizing commands
- **node-telegram-bot-api (v0.64.0)**: Telegram Bot API wrapper (minimal stub implementation)
  - **Configuration**: Requires `TELEGRAM_BOT_TOKEN` environment variable
  - **Note**: Optional component, system functions without it

## Configuration Management

- **dotenv (v16.3.1)**: Environment variable loader from `.env` file
  - API keys
  - Exchange credentials (read-only)
  - Bot tokens
  - LLM configuration

## Development & Testing

- **Jest (v29.7.0)**: Testing framework with TypeScript support via ts-jest
- **tsx (v4.7.0)**: TypeScript execution engine for development
- **ts-jest (v29.1.1)**: TypeScript preprocessor for Jest

## Type Definitions

- **@types/node**: Node.js type definitions
- **@types/node-telegram-bot-api**: Telegram bot API type definitions

## Future Extension Points

The architecture supports adding:
- Additional exchange clients (Binance, Bybit, etc.) via `ExchangeClient` interface
- New technical indicators in `src/indicators/`
- Custom trading strategies implementing `IStrategy`
- Alternative LLM providers implementing `LlmClient` interface
- News sources implementing news aggregation interfaces