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
  .option('--min-slope <number>', 'Minimum MA30 slope to confirm trend', '0.0001')
  .option('--min-distance <number>', 'Minimum price distance to MA30', '0.001')
  .action(async (options) => {
    const ohlcv = await fetchOHLCV(options.exchange, options.symbol, '15m', '2024-01-01', 1000, {
      rebuildCache: false,
    });
    const parsedSlopeWindow = Number(options.slopeWindow);
    const slopeWindow = Number.isFinite(parsedSlopeWindow) ? parsedSlopeWindow : 5;
    const parsedMinSlope = Number(options.minSlope);
    const minSlope = Number.isFinite(parsedMinSlope) ? parsedMinSlope : 0;
    const parsedMinDistance = Number(options.minDistance);
    const minDistance = Number.isFinite(parsedMinDistance) ? parsedMinDistance : 0;
    const { regime, slope, distance } = detectRegime(ohlcv, { slopeWindow, minSlope, minDistance });
    const periodStart = ohlcv.length ? new Date(ohlcv[0].timestamp).toISOString() : 'n/a';
    const periodEnd = ohlcv.length ? new Date(ohlcv[ohlcv.length - 1].timestamp).toISOString() : 'n/a';
    console.log(
      `Current regime for ${options.symbol}: ${regime} | slope: ${slope.toFixed(6)} | distance: ${distance.toFixed(
        6
      )} | period (15m): ${periodStart} → ${periodEnd}`
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
        console.log(`Realized PnL (gross): ${summary.realizedPnlGross.toFixed(4)} (quote)`);
        console.log(`Realized PnL (net): ${summary.realizedPnlNet.toFixed(4)} (quote)`);
        console.log(`Turnover: ${summary.turnover.toFixed(4)} (quote)`);
        console.log(`Avg profit/trade: ${summary.avgProfitPerTrade.toFixed(4)} (quote)`);
        console.log(`Fees: ${feesBreakdown || 'n/a'}`);
        if (summary.totalFeesInGt > 0) {
          const gtPrice = summary.gtPriceInQuote ? summary.gtPriceInQuote.toFixed(6) : 'n/a';
          console.log(
            `Fees in GT: ${summary.totalFeesInGt.toFixed(6)} GT (~${summary.gtFeeInQuote.toFixed(
              4
            )} USDT at ${gtPrice})`
          );
        }
        console.log(`Total fees (quote): ${summary.totalFeesInQuote.toFixed(4)}`);
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
        const hours = Math.max((summary.endTime.getTime() - summary.startTime.getTime()) / 3600000, 0);
        const gridTradesPerHour = hours > 0 ? gridResult.tradesCount / hours : gridResult.tradesCount;

        console.log('\nGrid backtest comparison (ledger vs grid)');
        const rows = [
          ['Realized PnL (net)', summary.realizedPnlNet, gridResult.pnlNet],
          ['Realized PnL (gross)', summary.realizedPnlGross, gridResult.pnlGross],
          ['Turnover', summary.turnover, gridResult.turnover],
          ['Fees total', summary.totalFeesInQuote, gridResult.feesTotal],
          ['Fee ratio', summary.feeRatio * 100, gridResult.feeRatio * 100],
          ['Trades/hour', summary.tradesPerHour, gridTradesPerHour],
          ['Avg profit/trade', summary.avgProfitPerTrade, gridResult.pnlNet / Math.max(1, gridResult.tradesCount)],
        ];

        const header = ['Metric', 'Ledger', 'Grid'];
        const formatNumber = (value: number, isPercent = false) =>
          isPercent ? `${value.toFixed(4)}%` : value.toFixed(4);

        const formattedRows = rows.map(([label, ledgerValue, gridValue]) => {
          const isPercent = label === 'Fee ratio';
          return [
            label,
            formatNumber(ledgerValue, isPercent),
            formatNumber(gridValue, isPercent)
          ];
        });

        const columns = [header, ...formattedRows];
        const colWidths = header.map((_, colIndex) =>
          Math.max(...columns.map((row) => row[colIndex].length))
        );

        const pad = (value: string, width: number) => value.padEnd(width, ' ');
        const lines = columns.map((row, rowIndex) => {
          const line = row.map((cell, colIndex) => pad(cell, colWidths[colIndex])).join(' | ');
          if (rowIndex === 0) {
            const separator = colWidths.map((width) => '-'.repeat(width)).join('-|-');
            return `${line}\n${separator}`;
          }
          return line;
        });

        console.log(lines.join('\n'));
        console.log(`PnL delta (net): ${(summary.realizedPnlNet - gridResult.pnlNet).toFixed(4)}`);
      } catch (error) {
        console.error('Error importing ledger:', error);
      }
  });

program.parse(process.argv);
