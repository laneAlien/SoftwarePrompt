# Crypto Trading AI Assistant

**Educational AI-powered cryptocurrency trading assistant with market simulation, technical analysis, and risk management.**

⚠️ **WARNING: This is an educational and analytical tool, NOT for real automated trading. Always make your own informed decisions. Trading cryptocurrencies carries significant risk.**

## Features

- 📊 **Technical Indicators**: RSI, MACD, EMA, SMA, Bollinger Bands
- 🎯 **Trading Strategies**: Scalping, Intraday, Swing, Position strategies
- 🤖 **AI Trading Bot**: Multi-layered simulation bot with market analysis
- 📉 **Market Simulator**: Generate artificial candles with trends, volatility, and shocks
- ⚖️ **Risk Management**: Liquidation price calculation, leverage risk assessment
- 💼 **Portfolio Analysis**: Multi-exchange portfolio aggregation and risk metrics
- 📰 **News Aggregation**: Crypto news and sentiment analysis
- 🤖 **OpenAI Integration**: LLM-powered market analysis (optional)
- 🔒 **Read-Only Exchange Integration**: KuCoin and Gate.io via ccxt
- 📱 **Telegram Bot**: Basic bot framework (optional)

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

### Environment Variables

Below is a complete example of the `.env` file (all keys are optional, but exchange keys enable live data):

```
# LLM Providers
OPENAI_API_KEY=your_openai_api_key_here
DEEPSEEK_API_KEY=your_deepseek_api_key_here

# KuCoin (read-only)
KUCOIN_API_KEY=your_kucoin_api_key
KUCOIN_API_SECRET=your_kucoin_api_secret
# Passphrase is created when you generate the API key (it is NOT the trading password)
KUCOIN_API_PASSPHRASE=your_kucoin_api_passphrase

# Gate.io (read-only)
GATE_API_KEY=your_gate_api_key
GATE_API_SECRET=your_gate_api_secret

# Optional integrations
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
```

**Notes:**
- Exchange API keys are used in **read-only** mode; no live trading is executed.
- KuCoin **passphrase** is set by you during API key creation and is required for request signatures.

## CLI Commands

### 1. Generate Market Simulation

```bash
npm start simulate -- --symbol TONUSDT --timeframe 15m --candles 500 --initial-price 2.5
```

Options:
- `--volatility <number>`: Market volatility (default: 0.02)
- `--trend-strength <number>`: Trend strength 0-1 (default: 0.3)
- `--shock-probability <number>`: Probability of price shocks (default: 0.05)

### 2. Run Trading Bot Simulation

```bash
npm start trade-sim -- --symbol TONUSDT --timeframe 15m --candles 1000 --initial-price 2.5
```

Options:
- `--initial-balance <number>`: Starting balance in USD (default: 10000)
- `--max-leverage <number>`: Maximum leverage (default: 5)
- `--mmr <number>`: Maintenance margin rate (default: 0.005)
- `--aggressiveness <number>`: Trading aggressiveness multiplier (0.5-2.0, default: 1)
- `--report <path>`: Inject CSV/TSV/Excel performance reports to bias risk when historical PnL is negative.
- `--save-chart` / `--export-report pdf|json|csv` / `--no-llm` for saving charts, exporting reports, and skipping LLM output.

### 3. Analyze Real Trading Pair

```bash
npm start analyze-pair -- --exchange kucoin --symbol TON/USDT --timeframe 15m --limit 200
```

Requires exchange API keys configured in `.env`.
- `--since YYYY-MM-DD` or `--months N` fetch multi-month OHLCV via paginated requests; `--no-cache` bypasses cached candles.
- OHLCV loading defaults to `--ohlcv-source auto` (cache + fetch missing), and CCXT rate limiting is enabled by default (override with `--no-rate-limit`).
- Indicators now include OBV/VWAP/funding rate and are shown in the console output.

### 4. Analyze Portfolio

```bash
npm start analyze-portfolio
```

Aggregates balances from configured exchanges.

### 5. Analyze Crypto News

```bash
npm start analyze-news -- --symbol TON
```

## Quick recipes

* посмотреть режим

```bash
npm start -- analyze-regime --exchange gate --symbol RAVE/USDT --since 2024-01-01 --ohlcv-source auto
```

* бэктест grid

```bash
npm start -- backtest-grid --symbol RAVE/USDT --since 2024-01-01 --mode spot
```

* сравнение с ledger

```bash
npm start -- compare ./data/ledger.csv --symbol RAVE/USDT
```

* PROMO MODE

```bash
npm start -- backtest-grid --profile promo --symbol RAVE/USDT --since 2024-01-01 --mode trailing --save-report
```

> По умолчанию stop по MA30 считается на 15m свечах (используйте `--ma-timeframe native`, чтобы оставить нативный таймфрейм).

## Report Analysis
Supply CSV/TSV/Excel reports containing `day`, `spent`, `voucherIncome`, and `profit` columns. The assistant aggregates totals and adjusts strategy confidence when losses dominate.

## LLM Integration
The LLM layer prefers **DeepSeek** when `DEEPSEEK_API_KEY` is present (base URL `https://api.deepseek.com/v1`, default model `deepseek-chat`), otherwise it uses OpenAI via `OPENAI_API_KEY` with `LLM_MODEL` set. Use `--no-llm` to disable prompts. Outputs are scenario-based (conservative/moderate/aggressive) and avoid direct buy/sell instructions.

## Historical Data & Funding
`analyze-pair` supports long lookbacks via `--since` or `--months`, invoking paginated `fetchFullOHLCV`. For perpetual pairs on sub-daily timeframes, funding rates are fetched and shown alongside OBV and VWAP.

## New Indicators & Strategies
OBV, VWAP, funding-rate-aware scoring, and volume/funding/multi-timeframe strategies are available. Strategy weights are combined to derive the aggregate signal.

> KuCoin API passphrase is the user-defined phrase set during API key creation (not the trading password).

## Architecture

```
src/
├── core/           # Types, interfaces, utilities
├── indicators/     # Technical indicators (RSI, MACD, EMA, etc.)
├── strategies/     # Trading strategies (scalping, intraday, swing, position)
├── simulation/     # Market simulator, order execution, AI trader bot
├── real/           # Exchange clients, portfolio analyzer, risk math
├── news/           # News aggregation and sentiment analysis
├── llm/            # OpenAI integration and prompts
└── ui/             # CLI interface and Telegram bot
```

## Multi-Layered AI Trading Bot

The simulation bot uses a sophisticated multi-layer architecture:

1. **Market Layer**: Fetches market state and price data
2. **Indicator Layer**: Computes technical indicators
3. **Strategy Layer**: Runs multiple strategies and combines signals
4. **Risk Layer**: Assesses liquidation risk and leverage
5. **LLM Layer** (Optional): AI-powered market analysis
6. **Decision Layer**: Makes final trading decisions
7. **Execution Layer**: Simulates order execution and PnL

## Risk Disclaimer

- This tool is for **educational purposes only**
- **NOT financial advice** - always do your own research
- Cryptocurrency trading carries **significant risk**
- **Leverage trading** can result in total loss of capital
- **Past performance does not guarantee future results**
- The developers are **not responsible** for any financial losses

## Testing

```bash
npm test
```

## License

MIT

## Contributing

Contributions welcome! This is an educational project focused on learning trading strategies, risk management, and AI integration.

## TODO for Users

- Add more technical indicators (ATR, Stochastic, etc.)
- Implement additional trading strategies
- Integrate more news sources
- Add web interface for visualization
- Enhance backtesting with historical data
- Implement portfolio optimization algorithms
