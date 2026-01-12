import 'dotenv/config';
import { Command } from 'commander';
import { fetchOHLCV } from './real/ohlcv';
import { detectRegime } from './core/regime';
import { importLedger } from './core/importLedger';

const program = new Command();

program
  .command('fetch-ohlcv')
  .option('--exchange <exchange>', 'Exchange ID', 'gate')
  .option('--symbol <symbol>', 'Symbol', 'RAVE/USDT')
  .option('--timeframe <timeframe>', 'Timeframe', '1m')
  .option('--since <since>', 'Start date (ISO)', '2025-12-12')
  .option('--limit <limit>', 'Max candles', '1000')
  .action(async (options) => {
    try {
      const limit = parseInt(options.limit, 10);
      const data = await fetchOHLCV(options.exchange, options.symbol, options.timeframe, options.since, limit);
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
  .action((file) => {
    try {
      const entries = importLedger(file);
      console.log(`Imported ${entries.length} entries from ledger.`);
      console.log('First entry:', entries[0]);
    } catch (error) {
      console.error('Error importing ledger:', error);
    }
  });

program.parse(process.argv);
