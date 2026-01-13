import 'dotenv/config';
import { Command } from 'commander';
import { fetchOHLCV } from './real/ohlcv';
import { detectRegime } from './core/regime';
import { analyzeLedger, importLedger } from './core/importLedger';
import { backtestSpotGrid } from './strategies/spotGrid';

const program = new Command();

program
  .command('fetch-ohlcv')
  .option('--exchange <exchange>', 'Exchange ID', 'gate')
  .option('--symbol <symbol>', 'Symbol', 'RAVE/USDT')
  .option('--timeframe <timeframe>', 'Timeframe', '1m')
  .option('--since <since>', 'Start date (ISO)', '2025-12-12')
  .option('--until <until>', 'End date (ISO)')
  .option('--limit <limit>', 'Max candles', '1000')
  .option('--rebuild', 'Rebuild cache', false)
  .action(async (options) => {
    try {
      const limit = parseInt(options.limit, 10);
      const data = await fetchOHLCV(options.exchange, options.symbol, options.timeframe, options.since, limit, {
        until: options.until,
        rebuildCache: options.rebuild,
      });
      console.log(`Fetched ${data.length} candles.`);
    } catch (error) {
      console.error('Error fetching OHLCV:', error);
    }
  });

program
  .command('analyze-regime')
  .option('--exchange <exchange>', 'Exchange ID', 'gate')
  .option('--symbol <symbol>', 'Symbol', 'RAVE/USDT')
  .option('--slope-window <number>', 'MA30 slope window', '5')
  .action(async (options) => {
    const ohlcv = await fetchOHLCV(options.exchange, options.symbol, '15m', '2024-01-01', 1000);
    const prices = ohlcv.map((candle) => candle.close);
    const parsedSlopeWindow = Number(options.slopeWindow);
    const slopeWindow = Number.isFinite(parsedSlopeWindow) ? parsedSlopeWindow : 5;
    const { regime, slope, distance } = detectRegime(prices, { slopeWindow });
    console.log(
      `Current regime for ${options.symbol}: ${regime} | slope: ${slope.toFixed(6)} | distance: ${distance.toFixed(6)}`
    );
  });

program
  .command('import-ledger')
  .argument('<file>', 'Path to CSV file')
  .option('--exchange <exchange>', 'Exchange ID', 'gate')
  .option('--symbol <symbol>', 'Symbol', 'RAVE/USDT')
  .option('--timeframe <timeframe>', 'Timeframe', '1m')
  .option('--grid-low <low>', 'Grid low price')
  .option('--grid-high <high>', 'Grid high price')
  .option('--grids <grids>', 'Grid levels', '10')
  .option('--allocation <allocation>', 'Allocation', '1000')
  .option('--fee-rate <feeRate>', 'Grid fee rate', '0.002')
  .option('--ohlcv-limit <limit>', 'Max candles', '10000')
  .action(async (file, options) => {
      try {
        const entries = importLedger(file);
        const summary = analyzeLedger(entries);
        console.log(`Imported ${entries.length} entries from ledger.`);
        if (!summary.startTime || !summary.endTime) {
          console.log('Not enough trade data to build a report.');
          return;
        }

        const feesBreakdown = Object.entries(summary.feesByCurrency)
          .map(([currency, amount]) => `${amount.toFixed(6)} ${currency}`)
          .join(', ');

        console.log('\nLedger report');
        console.log(`Period: ${summary.startTime.toISOString()} - ${summary.endTime.toISOString()}`);
        console.log(`Trades: ${summary.tradesCount}`);
        console.log(`Realized PnL: ${summary.realizedPnl.toFixed(4)} (quote)`);
        console.log(`Turnover: ${summary.turnover.toFixed(4)} (quote)`);
        console.log(`Avg profit/trade: ${summary.avgProfitPerTrade.toFixed(4)} (quote)`);
        console.log(`Fees: ${feesBreakdown || 'n/a'}`);
        console.log(`Fee ratio: ${(summary.feeRatio * 100).toFixed(4)}%`);
        console.log(`Trades/hour: ${summary.tradesPerHour.toFixed(2)}`);

        const limit = parseInt(options.ohlcvLimit, 10);
        const ohlcv = await fetchOHLCV(
          options.exchange,
          options.symbol,
          options.timeframe,
          summary.startTime.toISOString(),
          limit
        );
        const endTimeMs = summary.endTime.getTime();
        const periodCandles = ohlcv.filter((candle) => candle.timestamp <= endTimeMs);
        if (!periodCandles.length) {
          console.log('No OHLCV data available for the ledger period.');
          return;
        }

        const low = options.gridLow ? parseFloat(options.gridLow) : Math.min(...periodCandles.map((c) => c.low));
        const high = options.gridHigh ? parseFloat(options.gridHigh) : Math.max(...periodCandles.map((c) => c.high));
        const grids = parseInt(options.grids, 10);
        const allocation = parseFloat(options.allocation);
        const feeRate = parseFloat(options.feeRate);
        const gridResult = backtestSpotGrid(periodCandles, low, high, grids, allocation, feeRate);

        console.log('\nGrid backtest comparison');
        console.log(`Grid PnL (gross): ${gridResult.pnlGross.toFixed(4)}`);
        console.log(`Grid PnL (net): ${gridResult.pnlNet.toFixed(4)}`);
        console.log(`Grid turnover: ${gridResult.turnover.toFixed(4)}`);
        console.log(
          `Grid fees: ${gridResult.feesTotal.toFixed(4)} (ratio ${(gridResult.feeRatio * 100).toFixed(4)}%)`
        );
        console.log(`Ledger PnL: ${summary.realizedPnl.toFixed(4)}`);
        console.log(`PnL delta: ${(summary.realizedPnl - gridResult.pnlNet).toFixed(4)}`);
      } catch (error) {
        console.error('Error importing ledger:', error);
      }
  });

program.parse(process.argv);
