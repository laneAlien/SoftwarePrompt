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
  .action(async (options) => {
      // Mock data for now to demonstrate logic
      const prices = Array.from({length: 50}, () => Math.random() * 100);
      const regime = detectRegime(prices);
      console.log(`Current regime for ${options.symbol}: ${regime}`);
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
