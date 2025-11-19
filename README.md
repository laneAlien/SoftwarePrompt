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

### Required for LLM Analysis (Optional)
- `OPENAI_API_KEY`: Your OpenAI API key

### Required for Real Exchange Data (Optional)
- `KUCOIN_API_KEY`, `KUCOIN_API_SECRET`, `KUCOIN_API_PASSPHRASE`
- `GATE_API_KEY`, `GATE_API_SECRET`

### Required for Telegram Bot (Optional)
- `TELEGRAM_BOT_TOKEN`

**Note:** Exchange API keys are used in READ-ONLY mode. No real trading is executed.

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

### 3. Analyze Real Trading Pair

```bash
npm start analyze-pair -- --exchange kucoin --symbol TON/USDT --timeframe 15m --limit 200
```

Requires exchange API keys configured in `.env`.

### 4. Analyze Portfolio

```bash
npm start analyze-portfolio
```

Aggregates balances from configured exchanges.

### 5. Analyze Crypto News

```bash
npm start analyze-news -- --symbol TON
```

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
