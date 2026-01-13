import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { fetchOHLCV } from './real/ohlcv';
import { detectRegime } from './core/regime';
import { analyzeLedger, importLedger, LedgerFeeMode, LedgerSummary } from './core/importLedger';
import { GridResult, runGridBacktest } from './strategies/gridEngine';
import { backtestTrailingGrid } from './strategies/trailingGrid';

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

interface RegimeConfidenceOptions {
  minSlope: number;
  minDistance: number;
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

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function calculateRegimeConfidence(result: ReturnType<typeof detectRegime>, options: RegimeConfidenceOptions): number {
  const slopeDenominator = Math.max(options.minSlope, Number.EPSILON);
  const distanceDenominator = Math.max(options.minDistance, Number.EPSILON);
  const slopeScore = Math.min(1, Math.abs(result.slope) / slopeDenominator);
  const distanceScore = Math.min(1, Math.abs(result.distance) / distanceDenominator);
  return Math.round(((slopeScore + distanceScore) / 2) * 100);
}

function buildRecommendedCommand(params: {
  exchange: string;
  symbol: string;
  timeframe: string;
  since: string;
  until: string;
  ohlcvSource: OhlcvSource;
  feeModel: string;
  feeRate: number;
  makerFeeRate: number;
  takerFeeRate: number;
  gtDiscountRate: number;
  voucherDiscountType?: string;
  voucherDiscountValue?: string;
  minimumFee: number;
  feeRoundingDecimals?: string;
  slippageRate: number;
  mode: string;
}): string {
  const parts = [
    'npm run cli -- backtest-grid',
    `--exchange ${params.exchange}`,
    `--symbol ${params.symbol}`,
    `--timeframe ${params.timeframe}`,
    `--since ${params.since}`,
    `--until ${params.until}`,
    `--ohlcv-source ${params.ohlcvSource}`,
    `--mode ${params.mode}`,
    `--fee-model ${params.feeModel}`,
  ];

  if (params.feeModel === 'maker-taker') {
    parts.push(`--maker-fee-rate ${params.makerFeeRate}`, `--taker-fee-rate ${params.takerFeeRate}`);
  } else {
    parts.push(`--fee-rate ${params.feeRate}`);
  }

  parts.push(`--gt-discount-rate ${params.gtDiscountRate}`, `--minimum-fee ${params.minimumFee}`);

  if (params.voucherDiscountType && params.voucherDiscountValue) {
    parts.push(`--voucher-discount-type ${params.voucherDiscountType}`, `--voucher-discount-value ${params.voucherDiscountValue}`);
  }
  if (params.feeRoundingDecimals) {
    parts.push(`--fee-rounding-decimals ${params.feeRoundingDecimals}`);
  }
  if (params.slippageRate) {
    parts.push(`--slippage-rate ${params.slippageRate}`);
  }

  return parts.join(' ');
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
  const feesTotal = summary.totalFeesInQuoteWithGt;
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

function readLedgerFeeMode(options: Record<string, unknown>): LedgerFeeMode {
  const modeRaw = readStringOption(options, 'ledgerFeeMode');
  const normalized = (modeRaw ?? 'separate').toLowerCase();
  if (normalized === 'ohlcv') {
    return 'ohlcv';
  }
  return 'separate';
}

function createOhlcvPriceResolver(
  ohlcv: { timestamp: number; close: number }[]
): (timestamp: number) => number | null {
  const timestamps = ohlcv.map((candle) => candle.timestamp);
  return (timestamp: number) => {
    let left = 0;
    let right = timestamps.length - 1;
    let matchIndex = -1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (timestamps[mid] <= timestamp) {
        matchIndex = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    return matchIndex >= 0 ? ohlcv[matchIndex].close : null;
  };
}

async function resolveGtFeeQuoteResolver(
  entries: ReturnType<typeof importLedger>,
  options: Record<string, unknown>
): Promise<{ resolver?: (entry: ReturnType<typeof importLedger>[number]) => number | null; ohlcvCount: number }> {
  const gtFeeTimes = entries
    .filter((entry) => entry.actionType === 'fee' && entry.currency === 'GT')
    .map((entry) => Date.parse(entry.time))
    .filter((timestamp) => Number.isFinite(timestamp));
  if (!gtFeeTimes.length) {
    return { ohlcvCount: 0 };
  }
  const since = new Date(Math.min(...gtFeeTimes)).toISOString();
  const until = new Date(Math.max(...gtFeeTimes)).toISOString();
  const gtOhlcv = await resolveOhlcv({
    exchange: options.exchange,
    symbol: 'GT/USDT',
    timeframe: options.timeframe,
    since,
    until,
    ohlcvSource: options.ohlcvSource,
    ohlcvLimit: options.ohlcvLimit,
  });
  if (!gtOhlcv.length) {
    return { ohlcvCount: 0 };
  }
  const priceResolver = createOhlcvPriceResolver(gtOhlcv);
  return {
    ohlcvCount: gtOhlcv.length,
    resolver: (entry) => {
      const timestamp = Date.parse(entry.time);
      if (!Number.isFinite(timestamp)) {
        return null;
      }
      return priceResolver(timestamp);
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
  .command('decide')
  .option('--exchange <exchange>', 'Exchange ID', 'gate')
  .option('--symbol <symbol>', 'Symbol', 'RAVE/USDT')
  .option('--timeframe <timeframe>', 'Backtest timeframe', '1m')
  .option('--since <since>', 'Start date (ISO)', '2024-01-01')
  .option('--until <until>', 'End date (ISO)')
  .option('--limit <limit>', 'Max candles', '1000')
  .option('--slope-window <number>', 'MA30 slope window', '5')
  .option('--min-slope <number>', 'Minimum MA30 slope to confirm trend', '0.0001')
  .option('--min-distance <number>', 'Minimum price distance to MA30', '0.001')
  .option('--ohlcv-source <source>', 'OHLCV source: exchange|cache', 'exchange')
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
      const limit = parseInt(options.limit, 10);
      const since = readStringOption(options, 'since') ?? '2024-01-01';
      const until = readStringOption(options, 'until') ?? new Date().toISOString();
      const ohlcv = await resolveOhlcv({
        exchange: options.exchange,
        symbol: options.symbol,
        timeframe: '15m',
        since,
        until,
        limit,
        ohlcvSource: options.ohlcvSource,
      });
      if (!ohlcv.length) {
        console.log('No OHLCV data available to decide.');
        return;
      }
      const slopeWindow = parseNumber(readStringOption(options, 'slopeWindow'), 5);
      const minSlope = parseNumber(readStringOption(options, 'minSlope'), 0.0001);
      const minDistance = parseNumber(readStringOption(options, 'minDistance'), 0.001);
      const regimeResult = detectRegime(ohlcv, { slopeWindow, minSlope, minDistance });
      const confidence = calculateRegimeConfidence(regimeResult, { minSlope, minDistance });
      console.log(
        `Regime: ${regimeResult.regime} | slope: ${regimeResult.slope.toFixed(6)} | distance: ${regimeResult.distance.toFixed(
          6
        )} | confidence: ${confidence}`
      );

      const strategy =
        regimeResult.regime === 'TREND' ? 'trailing' : regimeResult.regime === 'RANGE' ? 'spot' : 'no-trade';
      console.log(`Strategy: ${strategy}`);

      const feeModel = (readStringOption(options, 'feeModel') ?? 'flat').toLowerCase();
      const recommendedMode = strategy === 'no-trade' ? 'spot' : strategy;
      const recommendedCommand = buildRecommendedCommand({
        exchange: readStringOption(options, 'exchange') ?? 'gate',
        symbol: readStringOption(options, 'symbol') ?? 'RAVE/USDT',
        timeframe: readStringOption(options, 'timeframe') ?? '1m',
        since,
        until,
        ohlcvSource: (readStringOption(options, 'ohlcvSource') as OhlcvSource) ?? 'exchange',
        feeModel,
        feeRate: parseNumber(readStringOption(options, 'feeRate'), 0.002),
        makerFeeRate: parseNumber(readStringOption(options, 'makerFeeRate'), 0.001),
        takerFeeRate: parseNumber(readStringOption(options, 'takerFeeRate'), 0.002),
        gtDiscountRate: parseNumber(readStringOption(options, 'gtDiscountRate'), 0),
        voucherDiscountType: readStringOption(options, 'voucherDiscountType'),
        voucherDiscountValue: readStringOption(options, 'voucherDiscountValue'),
        minimumFee: parseNumber(readStringOption(options, 'minimumFee'), 0),
        feeRoundingDecimals: readStringOption(options, 'feeRoundingDecimals'),
        slippageRate: parseNumber(readStringOption(options, 'slippageRate'), 0),
        mode: recommendedMode,
      });

      if (strategy === 'no-trade') {
        console.log('Recommended command (no-trade, for evaluation only):');
      } else {
        console.log('Recommended command:');
      }
      console.log(recommendedCommand);
    } catch (error) {
      console.error('Error deciding strategy:', error);
    }
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
  .option('--ledger-fee-mode <mode>', 'Ledger fee mode: separate|ohlcv', 'separate')
  .action(async (file, options) => {
      try {
        const entries = importLedger(file);
        const feeMode = readLedgerFeeMode(options);
        const gtFeeResolution =
          feeMode === 'ohlcv' ? await resolveGtFeeQuoteResolver(entries, options) : { resolver: undefined, ohlcvCount: 0 };
        const gtFeeQuoteResolver = gtFeeResolution.resolver;
        const summary = analyzeLedger(entries, { feeMode, gtFeeQuoteResolver });
        console.log(`Imported ${entries.length} entries from ledger.`);
        if (!summary.startTime || !summary.endTime) {
          console.log('Not enough trade data to build a report.');
          return;
        }

        const { metrics: ledgerMetrics, feesBreakdown } = buildLedgerMetrics(summary);

        console.log('\nLedger report');
        console.log(`Period: ${summary.startTime.toISOString()} - ${summary.endTime.toISOString()}`);
        console.log(`Avg profit/trade: ${summary.avgProfitPerTrade.toFixed(4)} (quote)`);
        if (summary.feeMode === 'ohlcv' && !gtFeeQuoteResolver) {
          console.log('GT/USDT OHLCV data unavailable; GT fees reported separately.');
        }
        console.log(`fees_total_quote: ${summary.totalFeesInQuote.toFixed(6)}`);
        console.log(`fees_total_gt: ${summary.totalFeesInGt.toFixed(6)}`);
        if (summary.feeMode === 'ohlcv') {
          console.log(`gt_fees_quote: ${summary.gtFeeInQuote.toFixed(6)}`);
          console.log(`fees_total_quote_equiv: ${summary.totalFeesInQuoteWithGt.toFixed(6)}`);
          if (summary.gtFeeMissingCount > 0) {
            console.log(`gt_fee_price_missing: ${summary.gtFeeMissingCount}`);
          }
        }
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
  .description(
    'Backtest grid strategy (spot uses static grid range; trailing shifts grid range with price and can stop on MA30/low closes).'
  )
  .option('--exchange <exchange>', 'Exchange ID', 'gate')
  .option('--symbol <symbol>', 'Symbol', 'RAVE/USDT')
  .option('--timeframe <timeframe>', 'Timeframe', '1m')
  .option('--since <since>', 'Start date (ISO)', '2025-12-12')
  .option('--until <until>', 'End date (ISO)')
  .option('--limit <limit>', 'Max candles', '1000')
  .option('--rebuild', 'Rebuild cache', false)
  .option('--ohlcv-source <source>', 'OHLCV source: exchange|cache', 'exchange')
  .option('--mode <mode>', 'Backtest mode: spot|trailing', 'spot')
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
  .option('--trail-step-percent <percent>', 'Trailing grid step percent')
  .option('--stop-on-ma30 <enabled>', 'Stop when close drops below MA30 (true|false)')
  .option('--stop-on-low-closes <count>', 'Stop after N closes below grid low')
  .action(async (options) => {
    try {
      const ohlcv = await resolveOhlcv(options);
      if (!ohlcv.length) {
        console.log('No OHLCV data available for backtest.');
        return;
      }
      const mode = (readStringOption(options, 'mode') ?? 'spot').toLowerCase();
      if (mode !== 'spot' && mode !== 'trailing') {
        throw new Error(`Unsupported mode "${mode}". Use spot or trailing.`);
      }

      const { low, high, grids, allocation } = resolveGridParams(options, ohlcv);
      const feeOptions = resolveFeeOptions(options);
      const trailStepPercent = parseOptionalNumber(readStringOption(options, 'trailStepPercent'));
      const stopOnMa30 = parseOptionalBoolean(readStringOption(options, 'stopOnMa30'));
      const stopOnLowCloses = parseOptionalNumber(readStringOption(options, 'stopOnLowCloses'));
      const commonOptions = {
        ohlcv,
        low,
        high,
        grids,
        allocation,
        ...feeOptions,
        trailStepPercent,
        stopOnMa30,
        stopOnLowCloses,
      };
      const gridResult =
        mode === 'trailing'
          ? backtestTrailingGrid({
              ...commonOptions,
              sourceTimeframe: readStringOption(options, 'timeframe'),
              trailStepPercent: trailStepPercent ?? 0,
              stopOnMa30,
              stopOnLowCloses,
            })
          : runGridBacktest(commonOptions);
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
  .option('--ledger-fee-mode <mode>', 'Ledger fee mode: separate|ohlcv', 'separate')
  .action(async (file, options) => {
    try {
      const entries = importLedger(file);
      const feeMode = readLedgerFeeMode(options);
      const gtFeeResolution =
        feeMode === 'ohlcv' ? await resolveGtFeeQuoteResolver(entries, options) : { resolver: undefined, ohlcvCount: 0 };
      const gtFeeQuoteResolver = gtFeeResolution.resolver;
      const summary = analyzeLedger(entries, { feeMode, gtFeeQuoteResolver });
      console.log(`Imported ${entries.length} entries from ledger.`);
      if (!summary.startTime || !summary.endTime) {
        console.log('Not enough trade data to build a report.');
        return;
      }

      const { metrics: ledgerMetrics, feesBreakdown } = buildLedgerMetrics(summary);
      console.log('\nLedger report');
      console.log(`Period: ${summary.startTime.toISOString()} - ${summary.endTime.toISOString()}`);
      if (summary.feeMode === 'ohlcv' && !gtFeeQuoteResolver) {
        console.log('GT/USDT OHLCV data unavailable; GT fees reported separately.');
      }
      console.log(`fees_total_quote: ${summary.totalFeesInQuote.toFixed(6)}`);
      console.log(`fees_total_gt: ${summary.totalFeesInGt.toFixed(6)}`);
      if (summary.feeMode === 'ohlcv') {
        console.log(`gt_fees_quote: ${summary.gtFeeInQuote.toFixed(6)}`);
        console.log(`fees_total_quote_equiv: ${summary.totalFeesInQuoteWithGt.toFixed(6)}`);
        if (summary.gtFeeMissingCount > 0) {
          console.log(`gt_fee_price_missing: ${summary.gtFeeMissingCount}`);
        }
      }
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
