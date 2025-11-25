import { Command } from 'commander';
import { generateCandles } from '../simulation/candleGenerator';
import { MarketSimulator } from '../simulation/marketSimulator';
import { OrderExecutionEngine } from '../simulation/orderExecution';
import { TradeBot } from '../simulation/tradeBot';
import { formatSimulationReport } from '../simulation/reporter';
import { KucoinClient } from '../real/kucoinClient';
import { GateClient } from '../real/gateClient';
import { analyzePortfolio } from '../real/portfolioAnalyzer';
import { computeIndicators } from '../indicators';
import { runAllStrategies, combineSignals } from '../strategies';
import { OpenAILlmClient } from '../llm/llmClient';
import { aggregateNews } from '../news/aggregator';
import { fetchNews } from '../news/newsFetcher';
import { parseReport } from '../reports/reportParser';
import { renderAsciiChart, renderChartPNG } from './charts';
import { exportReport } from '../reports/reportGenerator';
import { validateEnv } from '../utils/env';
import { fetchFundingRate } from '../indicators/fundingRate';
import { clearOhlcvCache } from '../real/exchangeUtils';

const program = new Command();

program
  .name('crypto-ai')
  .description('AI-powered crypto trading assistant with market simulation')
  .version('1.0.0');

program
  .command('simulate')
  .description('Generate artificial candles and display statistics')
  .requiredOption('--symbol <string>', 'Trading pair symbol (e.g., TONUSDT)')
  .requiredOption('--timeframe <string>', 'Timeframe (e.g., 1m, 15m, 1h)')
  .requiredOption('--candles <number>', 'Number of candles to generate')
  .requiredOption('--initial-price <number>', 'Initial price')
  .option('--volatility <number>', 'Volatility factor', '0.02')
  .option('--trend-strength <number>', 'Trend strength (0-1)', '0.3')
  .option('--shock-probability <number>', 'Shock probability (0-1)', '0.05')
  .action(async (options) => {
    console.log(`\nGenerating ${options.candles} candles for ${options.symbol}...\n`);
    
    const candles = generateCandles({
      initialPrice: parseFloat(options.initialPrice),
      candlesCount: parseInt(options.candles),
      timeframe: options.timeframe,
      volatility: parseFloat(options.volatility),
      trendStrength: parseFloat(options.trendStrength),
      shockProbability: parseFloat(options.shockProbability),
    });

    const prices = candles.map((c) => c.close);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const avg = prices.reduce((sum, p) => sum + p, 0) / prices.length;

    console.log(`Statistics:`);
    console.log(`  Min Price: $${min.toFixed(2)}`);
    console.log(`  Max Price: $${max.toFixed(2)}`);
    console.log(`  Avg Price: $${avg.toFixed(2)}`);
    console.log(`  Total Candles: ${candles.length}`);
    console.log(`\nSimulation data generated successfully.`);
  });

program
  .command('trade-sim')
  .description('Run AI TradeBot simulation')
  .requiredOption('--symbol <string>', 'Trading pair symbol')
  .requiredOption('--timeframe <string>', 'Timeframe')
  .requiredOption('--candles <number>', 'Number of candles')
  .requiredOption('--initial-price <number>', 'Initial price')
  .option('--initial-balance <number>', 'Initial balance in USD', '10000')
  .option('--max-leverage <number>', 'Maximum leverage', '5')
  .option('--mmr <number>', 'Maintenance margin rate', '0.005')
  .option('--history-window <number>', 'History window for indicators', '100')
  .option('--aggressiveness <number>', 'Trade aggressiveness multiplier (0.5-2.0)', '1')
  .option('--report <path>', 'External performance report (CSV/TSV/Excel) to adjust risk')
  .option('--save-chart', 'Save PNG and ASCII chart for the simulation')
  .option('--export-report <format>', 'Export simulation report as pdf|json|csv')
  .option('--no-llm', 'Disable LLM post-run analysis')
  .action(async (options) => {
    console.log(`\nStarting TradeBot simulation for ${options.symbol}...\n`);

    const reportSummary = options.report ? await parseReport(options.report) : undefined;

    const candles = generateCandles({
      initialPrice: parseFloat(options.initialPrice),
      candlesCount: parseInt(options.candles),
      timeframe: options.timeframe,
      volatility: 0.02,
      trendStrength: 0.3,
      shockProbability: 0.05,
    });

    const simulator = new MarketSimulator(options.symbol, options.timeframe, candles);
    const execution = new OrderExecutionEngine(parseFloat(options.initialBalance));
    
    const llmClient = options.noLlm
      ? undefined
      : process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY
      ? new OpenAILlmClient()
      : undefined;

    const bot = new TradeBot(
      {
        symbol: options.symbol,
        timeframe: options.timeframe,
        initialBalanceUsd: parseFloat(options.initialBalance),
      maxLeverage: parseFloat(options.maxLeverage),
      mmr: parseFloat(options.mmr),
      historyWindow: parseInt(options.historyWindow),
      aggressiveness: parseFloat(options.aggressiveness),
      reportSummary,
    },
    simulator,
    execution,
    llmClient
  );

    const report = await bot.runSimulation();
    console.log('\n' + formatSimulationReport(report));

    if (options.saveChart) {
      const pngPath = await renderChartPNG(candles, 'chart.png');
      console.log(`Saved chart to ${pngPath}`);
      console.log(renderAsciiChart(candles));
    }

    if (options.exportReport) {
      const exported = exportReport(report, { format: options.exportReport });
      console.log(`Exported simulation report -> ${exported}`);
    }

    if (llmClient) {
      const llmSummary = await llmClient.analyze(
        {
          symbol: options.symbol,
          timeframe: options.timeframe,
          simulation: {
            pnl: report.pnl,
            trades: report.trades,
            liquidations: report.liquidations,
            maxDrawdownPercent: report.maxDrawdown,
          },
          reportSummary,
        },
        'simulation'
      );
      console.log('\n=== LLM Simulation Insights ===');
      console.log(llmSummary.summary);
      console.log('Risks:', llmSummary.risks.join('; '));
    }
  });

program
  .command('analyze-pair')
  .description('Analyze a real trading pair')
  .requiredOption('--exchange <string>', 'Exchange name (kucoin | gate)')
  .requiredOption('--symbol <string>', 'Trading pair symbol')
  .requiredOption('--timeframe <string>', 'Timeframe')
  .option('--limit <number>', 'Number of candles', '200')
  .option('--since <string>', 'Start date (YYYY-MM-DD) for historical data')
  .option('--months <number>', 'Number of months back to fetch')
  .option('--no-llm', 'Disable LLM analysis output')
  .option('--no-cache', 'Bypass OHLCV cache for fresh pulls')
  .action(async (options) => {
    console.log(`\nAnalyzing ${options.symbol} on ${options.exchange}...\n`);

    try {
      if (options.noCache) {
        clearOhlcvCache();
      }
      const client = options.exchange === 'kucoin' ? new KucoinClient() : new GateClient();
      let since: number | undefined;
      let to: number | undefined;
      if (options.since) {
        since = Date.parse(options.since);
        to = Date.now();
      } else if (options.months) {
        const months = parseInt(options.months);
        to = Date.now();
        const date = new Date();
        date.setMonth(date.getMonth() - months);
        since = date.getTime();
      }

      const candles = await client.fetchCandles(
        options.symbol,
        options.timeframe,
        parseInt(options.limit),
        since,
        to,
        { skipCache: options.noCache }
      );
      const currentPrice = candles[candles.length - 1].close;

      let fundingRate: number | undefined;
      if (options.timeframe.endsWith('m') || options.timeframe.endsWith('h')) {
        const funding = await fetchFundingRate((client as any).exchange ?? (client as any), options.symbol).catch(() => null);
        fundingRate = funding?.rate;
      }

      const indicators = computeIndicators(candles, { fundingRate });
      const signals = runAllStrategies({
        symbol: options.symbol,
        timeframe: options.timeframe,
        candles,
        indicators,
        currentPrice,
        position: null,
      });
      const combinedSignal = combineSignals(signals);

      console.log(`Current Price: $${currentPrice.toFixed(2)}`);
      console.log(`\nIndicators:`);
      if (indicators.rsi) console.log(`  RSI: ${indicators.rsi.toFixed(2)}`);
      if (indicators.macd) console.log(`  MACD: ${indicators.macd.macd.toFixed(4)}`);
      if (indicators.emaFast) console.log(`  EMA Fast: ${indicators.emaFast.toFixed(2)}`);
      if (indicators.emaSlow) console.log(`  EMA Slow: ${indicators.emaSlow.toFixed(2)}`);
      if (typeof indicators.obv === 'number') console.log(`  OBV: ${indicators.obv.toFixed(2)}`);
      if (typeof indicators.vwap === 'number') console.log(`  VWAP: ${indicators.vwap.toFixed(4)}`);
      if (typeof indicators.fundingRate === 'number') console.log(`  Funding Rate: ${indicators.fundingRate}`);

      console.log(`\nCombined Signal: ${combinedSignal.action.toUpperCase()}`);
      console.log(`  Buy Score: ${combinedSignal.scoreBuy.toFixed(2)}`);
      console.log(`  Sell Score: ${combinedSignal.scoreSell.toFixed(2)}`);
      console.log(`  Hold Score: ${combinedSignal.scoreHold.toFixed(2)}`);

      console.log(`\nReasons:`);
      combinedSignal.reasons.forEach((r) => console.log(`  - ${r}`));

      if (!options.noLlm && (process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY)) {
        const llmClient = new OpenAILlmClient();
        const analysis = await llmClient.analyze(
          {
            symbol: options.symbol,
            timeframe: options.timeframe,
            candles,
            indicators,
            strategySignal: combinedSignal,
          },
          'pair'
        );

        console.log(`\n=== LLM Analysis ===`);
        console.log(analysis.summary);
        console.log('Risks:', analysis.risks.join('; '));
        console.log(`\nDisclaimer: ${analysis.disclaimer}`);
      }
    } catch (error) {
      console.error('Error analyzing pair:', error);
    }
  });

program
  .command('analyze-portfolio')
  .description('Analyze portfolio across exchanges')
  .option('--no-llm', 'Disable LLM analysis')
  .action(async (options) => {
    console.log('\nAnalyzing portfolio...\n');

    try {
      const clients = [];
      if (process.env.KUCOIN_API_KEY) clients.push(new KucoinClient());
      if (process.env.GATE_API_KEY) clients.push(new GateClient());

      if (clients.length === 0) {
        console.log('No exchange API keys configured. Please set KUCOIN_API_KEY or GATE_API_KEY in .env');
        return;
      }

      const portfolio = await analyzePortfolio(clients);

      console.log(`Total Portfolio Value: $${portfolio.totalValueUsd.toFixed(2)}`);
      console.log(`Stablecoins: ${portfolio.concentration.stablecoinsPercent.toFixed(1)}%`);
      console.log(`High Risk Assets: ${portfolio.concentration.highRiskPercent.toFixed(1)}%`);
      console.log(`\nTop Assets:`);
      portfolio.assets.slice(0, 5).forEach((asset) => {
        console.log(`  ${asset.symbol}: $${asset.valueUsd?.toFixed(2)} (${asset.exchange})`);
      });

      if (!options.noLlm && (process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY)) {
        const llm = new OpenAILlmClient();
        const analysis = await llm.analyze(
          {
            portfolioSummary: portfolio,
          },
          'portfolio'
        );
        console.log('\n=== LLM Portfolio View ===');
        console.log(analysis.summary);
        console.log('Risks:', analysis.risks.join('; '));
      }
    } catch (error) {
      console.error('Error analyzing portfolio:', error);
    }
  });

program
  .command('analyze-news')
  .description('Analyze news and signals')
  .option('--symbol <string>', 'Filter by symbol')
  .action(async (options) => {
    console.log('\nFetching news and signals...\n');

    try {
      const news = await aggregateNews(options.symbol);

      console.log(`Found ${news.length} items:\n`);
      news.forEach((item) => {
        console.log(`${item.title}`);
        console.log(`  Sentiment: ${item.sentiment} | Source: ${item.source} | Link: ${item.link}`);
      });

      if (process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY) {
        const llm = new OpenAILlmClient();
        const analysis = await llm.analyze(
          {
            news,
            symbol: options.symbol,
          } as any,
          'news'
        );
        console.log(`\nLLM summary:\n${analysis.summary}`);
        console.log(`Scenarios:`, analysis.scenarios);
      }
    } catch (error) {
      console.error('Error analyzing news:', error);
    }
  });

export function runCLI() {
  validateEnv([
    'KUCOIN_API_KEY',
    'KUCOIN_API_SECRET',
    'KUCOIN_API_PASSPHRASE',
    'GATE_API_KEY',
    'GATE_API_SECRET',
    'DEEPSEEK_API_KEY',
  ]);
  program.parse();
}
