import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { fetchOHLCV } from './real/ohlcv';
import { detectRegime } from './core/regime';
import { analyzeLedger, importLedger, LedgerSummary } from './core/importLedger';
import { GridResult, runGridBacktest } from './strategies/gridEngine';

const program = new Command();

type OhlcvSource = 'exchange' | 'cache';

interface OutputMetrics {
  pnlGross: number;
  pnlNet: number;
  feesTotal: number;
  feeRatio: number;
  trades: number;
  turnover: number;
}

interface GridFeeOptions {
  feeRate?: number;
  makerFeeRate?: number;
  takerFeeRate?: number;
  gtDiscountRate?: number;
  voucherDiscountType?: 'percent' | 'fixed';
  voucherDiscountValue?: number;
  minimumFee?: number;
  roundingDecimals?: number;
  slippageRate?: number;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readStringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' ? value : undefined;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatMetrics(label: string, metrics: OutputMetrics): void {
  console.log(`\n${label}`);
  console.log(`pnl_gross: ${metrics.pnlGross.toFixed(4)}`);
  console.log(`pnl_net: ${metrics.pnlNet.toFixed(4)}`);
  console.log(`fees_total: ${metrics.feesTotal.toFixed(4)}`);
  console.log(`fee_ratio: ${metrics.feeRatio.toFixed(6)}`);
  console.log(`trades: ${metrics.trades}`);
  console.log(`turnover: ${metrics.turnover.toFixed(4)}`);
}

function buildLedgerMetrics(summary: LedgerSummary): { metrics: OutputMetrics; feesBreakdown: string; feesTotal: number } {
  const feesBreakdown = Object.entries(summary.feesByCurrency)
    .map(([currency, amount]) => `${amount.toFixed(6)} ${currency}`)
    .join(', ');
  const feesTotal =
    typeof summary.totalFeesInQuote === 'number'
      ? summary.totalFeesInQuote
      : Object.entries(summary.feesByCurrency).reduce((sum, [currency, amount]) => {
          if (['USDT', 'USDC', 'USD', 'BUSD', 'DAI', 'TUSD'].includes(currency)) {
            return sum + amount;
          }
          return sum;
        }, 0);
  return {
    feesTotal,
    feesBreakdown,
    metrics: {
      pnlGross: summary.realizedPnlGross,
      pnlNet: summary.realizedPnlNet,
      feesTotal,
      feeRatio: summary.feeRatio,
      trades: summary.tradesCount,
      turnover: summary.turnover,
    },
  };
}

function buildGridMetrics(result: GridResult): OutputMetrics {
  return {
    pnlGross: result.pnlGross,
    pnlNet: result.pnlNet,
    feesTotal: result.feesTotal,
    feeRatio: result.feeRatio,
    trades: result.tradesCount,
    turnover: result.turnover,
  };
}

function resolveGridParams(
  options: Record<string, unknown>,
  candles: { low: number; high: number }[]
): { low: number; high: number; grids: number; allocation: number } {
  const gridLow = readStringOption(options, 'gridLow');
  const gridHigh = readStringOption(options, 'gridHigh');
  const gridsOption = readStringOption(options, 'grids');
  const allocationOption = readStringOption(options, 'allocation');
  const low = gridLow ? parseFloat(gridLow) : Math.min(...candles.map((c) => c.low));
  const high = gridHigh ? parseFloat(gridHigh) : Math.max(...candles.map((c) => c.high));
  const grids = parseNumber(gridsOption, 10);
  const allocation = parseNumber(allocationOption, 1000);
  return { low, high, grids, allocation };
}

function resolveFeeOptions(options: Record<string, unknown>): GridFeeOptions {
  const feeModel = (readStringOption(options, 'feeModel') ?? 'flat').toLowerCase();
  const feeRate = parseNumber(readStringOption(options, 'feeRate'), 0.002);
  const makerFeeRate = parseNumber(readStringOption(options, 'makerFeeRate'), 0.001);
  const takerFeeRate = parseNumber(readStringOption(options, 'takerFeeRate'), 0.002);
  const slippageRate = parseNumber(readStringOption(options, 'slippageRate'), 0);
  const gtDiscountRate = parseOptionalNumber(readStringOption(options, 'gtDiscountRate'));
  const voucherDiscountType = readStringOption(options, 'voucherDiscountType');
  const voucherDiscountValue = parseOptionalNumber(readStringOption(options, 'voucherDiscountValue'));
  const minimumFee = parseOptionalNumber(readStringOption(options, 'minimumFee'));
  const roundingDecimalsRaw = parseOptionalNumber(readStringOption(options, 'feeRoundingDecimals'));
  const roundingDecimals = roundingDecimalsRaw === undefined ? undefined : Math.trunc(roundingDecimalsRaw);
  const normalizedVoucherType =
    voucherDiscountType === 'percent' || voucherDiscountType === 'fixed' ? voucherDiscountType : undefined;
  if (feeModel === 'maker-taker') {
    return {
      makerFeeRate,
      takerFeeRate,
      slippageRate,
      gtDiscountRate,
      voucherDiscountType: normalizedVoucherType,
      voucherDiscountValue,
      minimumFee,
      roundingDecimals,
    };
  }
  return {
    feeRate,
    slippageRate,
    gtDiscountRate,
    voucherDiscountType: normalizedVoucherType,
    voucherDiscountValue,
    minimumFee,
    roundingDecimals,
  };
}

function resolveOhlcvCachePath(exchange: string, symbol: string, timeframe: string): string {
  return path.join('data', 'ohlcv', exchange, symbol.replace('/', '_'), `${timeframe}.jsonl`);
}

function loadOhlcvFromCache(
  exchange: string,
  symbol: string,
  timeframe: string,
  since: string,
  until?: string,
  limit = 1000
): { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[] {
  const cachePath = resolveOhlcvCachePath(exchange, symbol, timeframe);
  if (!fs.existsSync(cachePath)) {
    throw new Error(`Cache file not found: ${cachePath}`);
  }
  const sinceTime = Date.parse(since);
  const untilTime = until ? Date.parse(until) : Date.now();
  const rows = fs
    .readFileSync(cachePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return rows
    .filter((row) => row.timestamp >= sinceTime && row.timestamp <= untilTime)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, limit);
}

async function resolveOhlcv(options: Record<string, unknown>): Promise<ReturnType<typeof fetchOHLCV>> {
  const source = (readStringOption(options, 'ohlcvSource') as OhlcvSource) ?? 'exchange';
  const exchange = readStringOption(options, 'exchange') ?? 'gate';
  const symbol = readStringOption(options, 'symbol') ?? 'RAVE/USDT';
  const timeframe = readStringOption(options, 'timeframe') ?? '1m';
  const since = readStringOption(options, 'since') ?? '2025-12-12';
  const until = readStringOption(options, 'until');
  const limit = parseNumber(readStringOption(options, 'limit') ?? readStringOption(options, 'ohlcvLimit'), 1000);

  if (source === 'cache') {
    return loadOhlcvFromCache(exchange, symbol, timeframe, since, until, limit);
  }

  const rebuildOption = options.rebuild;
  const rebuildCache = typeof rebuildOption === 'boolean' ? rebuildOption : rebuildOption === 'true';
  return fetchOHLCV(exchange, symbol, timeframe, since, limit, {
    until,
    rebuildCache,
  });
}

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
  .option('--since <since>', 'Start date (ISO)', '2024-01-01')
  .option('--until <until>', 'End date (ISO)')
  .option('--limit <limit>', 'Max candles', '1000')
  .option('--slope-window <number>', 'MA30 slope window', '5')
  .option('--min-slope <number>', 'Minimum MA30 slope to confirm trend', '0.0001')
  .option('--min-distance <number>', 'Minimum price distance to MA30', '0.001')
  .action(async (options) => {
    const limit = parseInt(options.limit, 10);
    const ohlcv = await fetchOHLCV(options.exchange, options.symbol, '15m', options.since, limit, {
      rebuildCache: false,
      until: options.until,
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
  .option('--fee-model <model>', 'Fee model: flat|maker-taker', 'flat')
  .option('--fee-rate <feeRate>', 'Grid fee rate', '0.002')
  .option('--maker-fee-rate <rate>', 'Maker fee rate', '0.001')
  .option('--taker-fee-rate <rate>', 'Taker fee rate', '0.002')
  .option('--gt-discount-rate <rate>', 'GT discount rate (percent)', '0')
  .option('--voucher-discount-type <type>', 'Voucher discount type: percent|fixed')
  .option('--voucher-discount-value <value>', 'Voucher discount value')
  .option('--minimum-fee <fee>', 'Minimum fee per order', '0')
  .option('--fee-rounding-decimals <decimals>', 'Fee rounding decimals')
  .option('--slippage-rate <rate>', 'Slippage rate', '0')
  .option('--ohlcv-source <source>', 'OHLCV source: exchange|cache', 'exchange')
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

        const { metrics: ledgerMetrics, feesBreakdown } = buildLedgerMetrics(summary);

        console.log('\nLedger report');
        console.log(`Period: ${summary.startTime.toISOString()} - ${summary.endTime.toISOString()}`);
        console.log(`Avg profit/trade: ${summary.avgProfitPerTrade.toFixed(4)} (quote)`);
        console.log(`Fees: ${feesBreakdown || 'n/a'}`);
        console.log(`Trades/hour: ${summary.tradesPerHour.toFixed(2)}`);
        formatMetrics('Ledger metrics', ledgerMetrics);

        const ohlcv = await resolveOhlcv({
          exchange: options.exchange,
          symbol: options.symbol,
          timeframe: options.timeframe,
          since: summary.startTime.toISOString(),
          until: summary.endTime.toISOString(),
          ohlcvSource: options.ohlcvSource,
          ohlcvLimit: options.ohlcvLimit,
        });
        const endTimeMs = summary.endTime.getTime();
        const periodCandles = ohlcv.filter((candle) => candle.timestamp <= endTimeMs);
        if (!periodCandles.length) {
          console.log('No OHLCV data available for the ledger period.');
          return;
        }

        const { low, high, grids, allocation } = resolveGridParams(options, periodCandles);
        const feeOptions = resolveFeeOptions(options);
        const gridResult = runGridBacktest({
          ohlcv: periodCandles,
          low,
          high,
          grids,
          allocation,
          ...feeOptions,
        });

        formatMetrics('Grid backtest metrics', buildGridMetrics(gridResult));
        console.log(`PnL delta (ledger net vs grid net): ${(ledgerMetrics.pnlNet - gridResult.pnlNet).toFixed(4)}`);
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
  .option('--until <until>', 'End date (ISO)')
  .option('--limit <limit>', 'Max candles', '1000')
  .option('--rebuild', 'Rebuild cache', false)
  .option('--ohlcv-source <source>', 'OHLCV source: exchange|cache', 'exchange')
  .option('--grid-low <low>', 'Grid low price')
  .option('--grid-high <high>', 'Grid high price')
  .option('--grids <grids>', 'Grid levels', '10')
  .option('--allocation <allocation>', 'Allocation', '1000')
  .option('--fee-model <model>', 'Fee model: flat|maker-taker', 'flat')
  .option('--fee-rate <feeRate>', 'Grid fee rate', '0.002')
  .option('--maker-fee-rate <rate>', 'Maker fee rate', '0.001')
  .option('--taker-fee-rate <rate>', 'Taker fee rate', '0.002')
  .option('--gt-discount-rate <rate>', 'GT discount rate (percent)', '0')
  .option('--voucher-discount-type <type>', 'Voucher discount type: percent|fixed')
  .option('--voucher-discount-value <value>', 'Voucher discount value')
  .option('--minimum-fee <fee>', 'Minimum fee per order', '0')
  .option('--fee-rounding-decimals <decimals>', 'Fee rounding decimals')
  .option('--slippage-rate <rate>', 'Slippage rate', '0')
  .action(async (options) => {
    try {
      const ohlcv = await resolveOhlcv(options);
      if (!ohlcv.length) {
        console.log('No OHLCV data available for backtest.');
        return;
      }
      const { low, high, grids, allocation } = resolveGridParams(options, ohlcv);
      const feeOptions = resolveFeeOptions(options);
      const gridResult = runGridBacktest({
        ohlcv,
        low,
        high,
        grids,
        allocation,
        ...feeOptions,
      });
      formatMetrics('Grid backtest metrics', buildGridMetrics(gridResult));
    } catch (error) {
      console.error('Error running grid backtest:', error);
    }
  });

program
  .command('compare')
  .argument('<file>', 'Path to CSV file')
  .option('--exchange <exchange>', 'Exchange ID', 'gate')
  .option('--symbol <symbol>', 'Symbol', 'RAVE/USDT')
  .option('--timeframe <timeframe>', 'Timeframe', '1m')
  .option('--grid-low <low>', 'Grid low price')
  .option('--grid-high <high>', 'Grid high price')
  .option('--grids <grids>', 'Grid levels', '10')
  .option('--allocation <allocation>', 'Allocation', '1000')
  .option('--fee-model <model>', 'Fee model: flat|maker-taker', 'flat')
  .option('--fee-rate <feeRate>', 'Grid fee rate', '0.002')
  .option('--maker-fee-rate <rate>', 'Maker fee rate', '0.001')
  .option('--taker-fee-rate <rate>', 'Taker fee rate', '0.002')
  .option('--gt-discount-rate <rate>', 'GT discount rate (percent)', '0')
  .option('--voucher-discount-type <type>', 'Voucher discount type: percent|fixed')
  .option('--voucher-discount-value <value>', 'Voucher discount value')
  .option('--minimum-fee <fee>', 'Minimum fee per order', '0')
  .option('--fee-rounding-decimals <decimals>', 'Fee rounding decimals')
  .option('--slippage-rate <rate>', 'Slippage rate', '0')
  .option('--ohlcv-source <source>', 'OHLCV source: exchange|cache', 'exchange')
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

      const { metrics: ledgerMetrics, feesBreakdown } = buildLedgerMetrics(summary);
      console.log('\nLedger report');
      console.log(`Period: ${summary.startTime.toISOString()} - ${summary.endTime.toISOString()}`);
      console.log(`Fees: ${feesBreakdown || 'n/a'}`);
      formatMetrics('Ledger metrics', ledgerMetrics);

      const ohlcv = await resolveOhlcv({
        exchange: options.exchange,
        symbol: options.symbol,
        timeframe: options.timeframe,
        since: summary.startTime.toISOString(),
        until: summary.endTime.toISOString(),
        ohlcvSource: options.ohlcvSource,
        ohlcvLimit: options.ohlcvLimit,
      });
      if (!ohlcv.length) {
        console.log('No OHLCV data available for the ledger period.');
        return;
      }
      const endTimeMs = summary.endTime.getTime();
      const periodCandles = ohlcv.filter((candle) => candle.timestamp <= endTimeMs);
      if (!periodCandles.length) {
        console.log('No OHLCV data available for the ledger period.');
        return;
      }

      const { low, high, grids, allocation } = resolveGridParams(options, periodCandles);
      const feeOptions = resolveFeeOptions(options);
      const gridResult = runGridBacktest({
        ohlcv: periodCandles,
        low,
        high,
        grids,
        allocation,
        ...feeOptions,
      });

      formatMetrics('Grid backtest metrics', buildGridMetrics(gridResult));
      console.log(`PnL delta (ledger net vs grid net): ${(ledgerMetrics.pnlNet - gridResult.pnlNet).toFixed(4)}`);
    } catch (error) {
      console.error('Error comparing ledger to backtest:', error);
    }
  });

program.parse(process.argv);
