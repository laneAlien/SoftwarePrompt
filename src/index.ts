import 'dotenv/config';
import { Command } from 'commander';
import { fetchOHLCV } from './real/ohlcv';
import { detectRegime } from './core/regime';
import { calculateLedgerMetrics, importLedger } from './core/importLedger';
import { backtestSpotGrid, GridConfig } from './strategies/spotGrid';
import { FeeModelGate } from './core/feeModelGate';

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
  .option('--timeframe <timeframe>', 'Timeframe', '15m')
  .option('--since <since>', 'Start date (ISO)')
  .option('--limit <limit>', 'Max candles', '1000')
  .option('--slope-lookback <slopeLookback>', 'Slope lookback points', '10')
  .option('--slope-threshold <slopeThreshold>', 'Slope threshold', '0')
  .action(async (options) => {
      const since = options.since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const limit = parseInt(options.limit, 10);
      const slopeLookback = parseInt(options.slopeLookback, 10);
      const slopeThreshold = parseFloat(options.slopeThreshold);
      const data = await fetchOHLCV(options.exchange, options.symbol, options.timeframe, since, limit);
      const prices = data.map(candle => candle.close);
      const result = detectRegime(prices, slopeLookback, slopeThreshold);
      console.log(`Current regime for ${options.symbol}: ${result.regime}`);
      console.log(`MA30: ${result.ma30.toFixed(4)} | slope: ${result.slope.toFixed(6)} | distance: ${result.distance.toFixed(4)}`);
  });

program
  .command('import-ledger')
  .argument('<file>', 'Path to CSV file')
  .option('--quote <quote>', 'Quote currency', 'USDT')
  .option('--gt-price <gtPrice>', 'GT price in quote currency', '0')
  .action((file, options) => {
      try {
        const entries = importLedger(file);
        const metrics = calculateLedgerMetrics(entries, {
          quoteCurrency: options.quote,
          gtPrice: parseFloat(options.gtPrice),
        });
        console.log(`Imported ${entries.length} entries from ledger.`);
        console.log('Ledger metrics:', metrics);
      } catch (error) {
        console.error('Error importing ledger:', error);
      }
  });

program
  .command('backtest-grid')
  .option('--exchange <exchange>', 'Exchange ID', 'gate')
  .option('--symbol <symbol>', 'Symbol', 'RAVE/USDT')
  .option('--timeframe <timeframe>', 'Timeframe', '1m')
  .option('--since <since>', 'Start date (ISO)', '2025-12-12')
  .option('--limit <limit>', 'Max candles', '1000')
  .option('--low <low>', 'Grid low price', '1')
  .option('--high <high>', 'Grid high price', '2')
  .option('--grids <grids>', 'Number of grids', '10')
  .option('--allocation <allocation>', 'Quote allocation', '1000')
  .option('--maker <maker>', 'Maker fee rate', '0.0002')
  .option('--taker <taker>', 'Taker fee rate', '0.0004')
  .option('--gt-discount <gtDiscount>', 'GT discount rate', '0')
  .option('--voucher-discount <voucherDiscount>', 'Voucher discount rate', '0')
  .option('--voucher-fixed <voucherFixed>', 'Voucher fixed discount', '0')
  .option('--min-fee <minFee>', 'Minimum fee', '0')
  .option('--maker-slippage <makerSlippage>', 'Maker slippage rate', '0')
  .option('--taker-slippage <takerSlippage>', 'Taker slippage rate', '0')
  .option('--execution <execution>', 'maker|taker', 'maker')
  .action(async (options) => {
    const limit = parseInt(options.limit, 10);
    const data = await fetchOHLCV(options.exchange, options.symbol, options.timeframe, options.since, limit);
    const feeModel: FeeModelGate = {
      makerRate: parseFloat(options.maker),
      takerRate: parseFloat(options.taker),
      gtDiscountRate: parseFloat(options.gtDiscount),
      voucherDiscountRate: parseFloat(options.voucherDiscount),
      voucherDiscountFixed: parseFloat(options.voucherFixed),
      minimumFee: parseFloat(options.minFee),
    };
    const config: GridConfig = {
      low: parseFloat(options.low),
      high: parseFloat(options.high),
      grids: parseInt(options.grids, 10),
      allocation: parseFloat(options.allocation),
      feeModel,
      slippageModel: {
        maker: parseFloat(options.makerSlippage),
        taker: parseFloat(options.takerSlippage),
      },
      execution: options.execution === 'taker' ? 'taker' : 'maker',
    };
    const result = backtestSpotGrid(data, config);
    console.log('Grid backtest result:', result);
  });

program
  .command('compare-ledger')
  .argument('<file>', 'Path to CSV file')
  .option('--exchange <exchange>', 'Exchange ID', 'gate')
  .option('--symbol <symbol>', 'Symbol', 'RAVE/USDT')
  .option('--timeframe <timeframe>', 'Timeframe', '1m')
  .option('--since <since>', 'Start date (ISO)', '2025-12-12')
  .option('--until <until>', 'End date (ISO)')
  .option('--limit <limit>', 'Max candles', '1000')
  .option('--low <low>', 'Grid low price', '1')
  .option('--high <high>', 'Grid high price', '2')
  .option('--grids <grids>', 'Number of grids', '10')
  .option('--allocation <allocation>', 'Quote allocation', '1000')
  .option('--maker <maker>', 'Maker fee rate', '0.0002')
  .option('--taker <taker>', 'Taker fee rate', '0.0004')
  .option('--gt-discount <gtDiscount>', 'GT discount rate', '0')
  .option('--voucher-discount <voucherDiscount>', 'Voucher discount rate', '0')
  .option('--voucher-fixed <voucherFixed>', 'Voucher fixed discount', '0')
  .option('--min-fee <minFee>', 'Minimum fee', '0')
  .option('--maker-slippage <makerSlippage>', 'Maker slippage rate', '0')
  .option('--taker-slippage <takerSlippage>', 'Taker slippage rate', '0')
  .option('--execution <execution>', 'maker|taker', 'maker')
  .option('--quote <quote>', 'Quote currency', 'USDT')
  .option('--gt-price <gtPrice>', 'GT price in quote currency', '0')
  .action(async (file, options) => {
    const limit = parseInt(options.limit, 10);
    const candles = await fetchOHLCV(options.exchange, options.symbol, options.timeframe, options.since, limit, {
      until: options.until,
    });
    const feeModel: FeeModelGate = {
      makerRate: parseFloat(options.maker),
      takerRate: parseFloat(options.taker),
      gtDiscountRate: parseFloat(options.gtDiscount),
      voucherDiscountRate: parseFloat(options.voucherDiscount),
      voucherDiscountFixed: parseFloat(options.voucherFixed),
      minimumFee: parseFloat(options.minFee),
    };
    const config: GridConfig = {
      low: parseFloat(options.low),
      high: parseFloat(options.high),
      grids: parseInt(options.grids, 10),
      allocation: parseFloat(options.allocation),
      feeModel,
      slippageModel: {
        maker: parseFloat(options.makerSlippage),
        taker: parseFloat(options.takerSlippage),
      },
      execution: options.execution === 'taker' ? 'taker' : 'maker',
    };

    const backtest = backtestSpotGrid(candles, config);
    const entries = importLedger(file);
    const ledgerMetrics = calculateLedgerMetrics(entries, {
      quoteCurrency: options.quote,
      gtPrice: parseFloat(options.gtPrice),
    });

    console.log('Backtest result:', backtest);
    console.log('Ledger metrics:', ledgerMetrics);
  });

program.parse(process.argv);
