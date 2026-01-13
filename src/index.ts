import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { fetchOHLCV } from './real/ohlcv';
import { detectRegime } from './core/regime';
import { analyzeLedger, importLedger, LedgerFeeMode, LedgerSummary } from './core/importLedger';
import { getProfileDefaults } from './core/profiles';
import { GridResult, runGridBacktest } from './strategies/gridEngine';
import { backtestTrailingGrid } from './strategies/trailingGrid';
import { FeeDefaults, loadConfig } from './core/config';

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

function isFlagSet(flags: string[]): boolean {
  const argv = process.argv.slice(2);
  return flags.some((flag) => argv.includes(flag) || argv.some((arg) => arg.startsWith(`${flag}=`)));
}

function resolveProfiledNumber(
  options: Record<string, unknown>,
  key: string,
  flags: string[],
  profileValue: number | undefined,
  fallback: number,
  configValue?: number
): number {
  const raw = readStringOption(options, key);
  if (isFlagSet(flags)) {
    return parseNumber(raw, fallback);
  }
  if (profileValue !== undefined) {
    return profileValue;
  }
  if (configValue !== undefined) {
    return configValue;
  }
  return fallback;
}

function resolveProfiledOptionalNumber(
  options: Record<string, unknown>,
  key: string,
  flags: string[],
  profileValue: number | undefined,
  configValue?: number
): number | undefined {
  const raw = readStringOption(options, key);
  if (isFlagSet(flags)) {
    return parseOptionalNumber(raw);
  }
  if (profileValue !== undefined) {
    return profileValue;
  }
  if (configValue !== undefined) {
    return configValue;
  }
  return parseOptionalNumber(raw);
}

function resolveProfiledOptionalBoolean(
  options: Record<string, unknown>,
  key: string,
  flags: string[],
  profileValue: boolean | undefined,
  configValue?: boolean
): boolean | undefined {
  const raw = readStringOption(options, key);
  if (isFlagSet(flags)) {
    return parseOptionalBoolean(raw);
  }
  if (profileValue !== undefined) {
    return profileValue;
  }
  if (configValue !== undefined) {
    return configValue;
  }
  return parseOptionalBoolean(raw);
}

function resolveProfiledString(
  options: Record<string, unknown>,
  key: string,
  flags: string[],
  profileValue: string | undefined,
  fallback: string,
  configValue?: string
): string {
  const raw = readStringOption(options, key);
  if (isFlagSet(flags)) {
    return raw ?? fallback;
  }
  if (profileValue !== undefined) {
    return profileValue;
  }
  if (configValue !== undefined) {
    return configValue;
  }
  return raw ?? fallback;
}

function resolveConfigString(
  options: Record<string, unknown>,
  key: string,
  flags: string[],
  configValue: string | undefined,
  fallback: string
): string {
  const raw = readStringOption(options, key);
  if (isFlagSet(flags)) {
    return raw ?? fallback;
  }
  if (configValue !== undefined) {
    return configValue;
  }
  return fallback;
}

function resolveConfigOptionalString(
  options: Record<string, unknown>,
  key: string,
  flags: string[],
  configValue: string | undefined
): string | undefined {
  const raw = readStringOption(options, key);
  if (isFlagSet(flags)) {
    return raw;
  }
  if (configValue !== undefined) {
    return configValue;
  }
  return undefined;
}

function resolveConfigNumber(
  options: Record<string, unknown>,
  key: string,
  flags: string[],
  configValue: number | undefined,
  fallback: number
): number {
  const raw = readStringOption(options, key);
  if (isFlagSet(flags)) {
    return parseNumber(raw, fallback);
  }
  if (configValue !== undefined) {
    return configValue;
  }
  return fallback;
}

function resolveConfigOptionalNumber(
  options: Record<string, unknown>,
  key: string,
  flags: string[],
  configValue: number | undefined
): number | undefined {
  const raw = readStringOption(options, key);
  if (isFlagSet(flags)) {
    return parseOptionalNumber(raw);
  }
  if (configValue !== undefined) {
    return configValue;
  }
  return undefined;
}

function resolveFeeInputs(
  options: Record<string, unknown>,
  defaults: FeeDefaults,
  slippageRateOverride?: number
): {
  feeRate: number;
  makerFeeRate: number;
  takerFeeRate: number;
  gtDiscountRate: number;
  voucherDiscountType?: string;
  voucherDiscountValue?: number;
  minimumFee: number;
  roundingDecimals?: number;
  slippageRate: number;
} {
  const feeRate = resolveConfigNumber(options, 'feeRate', ['--fee-rate'], defaults.feeRate, 0.002);
  const makerFeeRate = resolveConfigNumber(options, 'makerFeeRate', ['--maker-fee-rate'], defaults.makerFeeRate, 0.001);
  const takerFeeRate = resolveConfigNumber(options, 'takerFeeRate', ['--taker-fee-rate'], defaults.takerFeeRate, 0.002);
  const gtDiscountRate = resolveConfigNumber(options, 'gtDiscountRate', ['--gt-discount-rate'], defaults.gtDiscountRate, 0);
  const voucherDiscountType = resolveConfigOptionalString(
    options,
    'voucherDiscountType',
    ['--voucher-discount-type'],
    defaults.voucherDiscountType
  );
  const voucherDiscountValue = resolveConfigOptionalNumber(
    options,
    'voucherDiscountValue',
    ['--voucher-discount-value'],
    defaults.voucherDiscountValue
  );
  const minimumFee = resolveConfigNumber(options, 'minimumFee', ['--minimum-fee'], defaults.minimumFee, 0);
  const roundingDecimals = resolveConfigOptionalNumber(
    options,
    'feeRoundingDecimals',
    ['--fee-rounding-decimals'],
    defaults.roundingDecimals
  );
  const slippageRate =
    slippageRateOverride ?? resolveConfigNumber(options, 'slippageRate', ['--slippage-rate'], defaults.slippageRate, 0);
  return {
    feeRate,
    makerFeeRate,
    takerFeeRate,
    gtDiscountRate,
    voucherDiscountType,
    voucherDiscountValue,
    minimumFee,
    roundingDecimals: roundingDecimals === undefined ? undefined : Math.trunc(roundingDecimals),
    slippageRate,
  };
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
  profile?: string;
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
    params.profile ? `--profile ${params.profile}` : undefined,
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

  return parts.filter((part): part is string => Boolean(part)).join(' ');
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
  candles: { low: number; high: number }[],
  overrides?: { grids?: number; allocation?: number }
): { low: number; high: number; grids: number; allocation: number } {
  const gridLow = readStringOption(options, 'gridLow');
  const gridHigh = readStringOption(options, 'gridHigh');
  const gridsOption = readStringOption(options, 'grids');
  const allocationOption = readStringOption(options, 'allocation');
  const low = gridLow ? parseFloat(gridLow) : Math.min(...candles.map((c) => c.low));
  const high = gridHigh ? parseFloat(gridHigh) : Math.max(...candles.map((c) => c.high));
  const grids = overrides?.grids ?? parseNumber(gridsOption, 10);
  const allocation = overrides?.allocation ?? parseNumber(allocationOption, 1000);
  return { low, high, grids, allocation };
}

function resolveFeeOptions(
  options: Record<string, unknown>,
  overrides?: { feeModel?: string; slippageRate?: number },
  defaults: FeeDefaults = {}
): GridFeeOptions {
  const feeModel = (overrides?.feeModel ??
    resolveConfigString(options, 'feeModel', ['--fee-model'], defaults.model, 'flat')).toLowerCase();
  const feeInputs = resolveFeeInputs(options, defaults, overrides?.slippageRate);
  const normalizedVoucherType =
    feeInputs.voucherDiscountType === 'percent' || feeInputs.voucherDiscountType === 'fixed'
      ? feeInputs.voucherDiscountType
      : undefined;
  if (feeModel === 'maker-taker') {
    return {
      makerFeeRate: feeInputs.makerFeeRate,
      takerFeeRate: feeInputs.takerFeeRate,
      slippageRate: feeInputs.slippageRate,
      gtDiscountRate: feeInputs.gtDiscountRate,
      voucherDiscountType: normalizedVoucherType,
      voucherDiscountValue: feeInputs.voucherDiscountValue,
      minimumFee: feeInputs.minimumFee,
      roundingDecimals: feeInputs.roundingDecimals,
    };
  }
  return {
    feeRate: feeInputs.feeRate,
    slippageRate: feeInputs.slippageRate,
    gtDiscountRate: feeInputs.gtDiscountRate,
    voucherDiscountType: normalizedVoucherType,
    voucherDiscountValue: feeInputs.voucherDiscountValue,
    minimumFee: feeInputs.minimumFee,
    roundingDecimals: feeInputs.roundingDecimals,
  };
}

function formatProfileSummary(params: {
  profile: string;
  grids?: number;
  feeModel?: string;
  slippageRate?: number;
  trailStepPercent?: number;
  stopOnMa30?: boolean;
  stopOnLowCloses?: number;
}): void {
  const formatValue = (value: number | boolean | string | undefined): string =>
    value === undefined ? 'n/a' : String(value);
  console.log(`Profile: ${params.profile}`);
  console.log(
    [
      `grids=${formatValue(params.grids)}`,
      `fee_model=${formatValue(params.feeModel)}`,
      `slippage_rate=${formatValue(params.slippageRate)}`,
      `trail_step_percent=${formatValue(params.trailStepPercent)}`,
      `stop_on_ma30=${formatValue(params.stopOnMa30)}`,
      `stop_on_low_closes=${formatValue(params.stopOnLowCloses)}`,
    ].join(' | ')
  );
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
  .option('--profile <profile>', 'Profile name: default|promo|safe', 'default')
  .option('--config <path>', 'Config path')
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
      const config = loadConfig(readStringOption(options, 'config'));
      const outputDefaults = config.output ?? {};
      const feeDefaults = config.fees ?? {};
      const defaultSymbol = config.symbols?.[0] ?? 'RAVE/USDT';
      const exchange = resolveConfigString(options, 'exchange', ['--exchange'], config.exchange, 'gate');
      const symbol = resolveConfigString(options, 'symbol', ['--symbol'], defaultSymbol, 'RAVE/USDT');
      const timeframe = resolveConfigString(options, 'timeframe', ['--timeframe'], outputDefaults.timeframe, '1m');
      const limit = resolveConfigNumber(options, 'limit', ['--limit'], outputDefaults.limit, 1000);
      const since = resolveConfigString(options, 'since', ['--since'], outputDefaults.since, '2024-01-01');
      const until =
        resolveConfigOptionalString(options, 'until', ['--until'], outputDefaults.until) ?? new Date().toISOString();
      const ohlcvSource = resolveConfigString(
        options,
        'ohlcvSource',
        ['--ohlcv-source'],
        outputDefaults.ohlcvSource,
        'exchange'
      );
      const { name: profileName, defaults: profileDefaults } = getProfileDefaults(readStringOption(options, 'profile'));
      const ohlcv = await resolveOhlcv({
        exchange,
        symbol,
        timeframe: '15m',
        since,
        until,
        limit: String(limit),
        ohlcvSource,
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

      const feeModel = resolveProfiledString(
        options,
        'feeModel',
        ['--fee-model'],
        profileDefaults.feeModel,
        'flat',
        feeDefaults.model
      ).toLowerCase();
      const slippageRate = resolveProfiledNumber(
        options,
        'slippageRate',
        ['--slippage-rate'],
        profileDefaults.slippageRate,
        0,
        feeDefaults.slippageRate
      );
      const feeInputs = resolveFeeInputs(options, feeDefaults, slippageRate);
      formatProfileSummary({
        profile: profileName,
        grids: profileDefaults.grids,
        feeModel,
        slippageRate,
        trailStepPercent: profileDefaults.trailStepPercent,
        stopOnMa30: profileDefaults.stopOnMa30,
        stopOnLowCloses: profileDefaults.stopOnLowCloses,
      });
      const recommendedMode = strategy === 'no-trade' ? 'spot' : strategy;
      const recommendedCommand = buildRecommendedCommand({
        exchange,
        symbol,
        timeframe,
        since,
        until,
        ohlcvSource,
        profile: profileName,
        feeModel,
        feeRate: feeInputs.feeRate,
        makerFeeRate: feeInputs.makerFeeRate,
        takerFeeRate: feeInputs.takerFeeRate,
        gtDiscountRate: feeInputs.gtDiscountRate,
        voucherDiscountType: feeInputs.voucherDiscountType,
        voucherDiscountValue: feeInputs.voucherDiscountValue ? String(feeInputs.voucherDiscountValue) : undefined,
        minimumFee: feeInputs.minimumFee,
        feeRoundingDecimals:
          feeInputs.roundingDecimals === undefined ? undefined : String(feeInputs.roundingDecimals),
        slippageRate,
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
  .option('--profile <profile>', 'Profile name: default|promo|safe', 'default')
  .option('--config <path>', 'Config path')
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
      const config = loadConfig(readStringOption(options, 'config'));
      const outputDefaults = config.output ?? {};
      const feeDefaults = config.fees ?? {};
      const defaultSymbol = config.symbols?.[0] ?? 'RAVE/USDT';
      const exchange = resolveConfigString(options, 'exchange', ['--exchange'], config.exchange, 'gate');
      const symbol = resolveConfigString(options, 'symbol', ['--symbol'], defaultSymbol, 'RAVE/USDT');
      const timeframe = resolveConfigString(options, 'timeframe', ['--timeframe'], outputDefaults.timeframe, '1m');
      const since = resolveConfigString(options, 'since', ['--since'], outputDefaults.since, '2025-12-12');
      const until = resolveConfigOptionalString(options, 'until', ['--until'], outputDefaults.until);
      const limit = resolveConfigNumber(options, 'limit', ['--limit'], outputDefaults.limit, 1000);
      const ohlcvSource = resolveConfigString(
        options,
        'ohlcvSource',
        ['--ohlcv-source'],
        outputDefaults.ohlcvSource,
        'exchange'
      );
      const mode = resolveConfigString(options, 'mode', ['--mode'], outputDefaults.mode, 'spot').toLowerCase();
      const ohlcv = await resolveOhlcv({
        exchange,
        symbol,
        timeframe,
        since,
        until,
        limit: String(limit),
        ohlcvSource,
        rebuild: options.rebuild,
      });
      if (!ohlcv.length) {
        console.log('No OHLCV data available for backtest.');
        return;
      }
      if (mode !== 'spot' && mode !== 'trailing') {
        throw new Error(`Unsupported mode "${mode}". Use spot or trailing.`);
      }

      const { name: profileName, defaults: profileDefaults } = getProfileDefaults(readStringOption(options, 'profile'));
      const grids = resolveProfiledNumber(options, 'grids', ['--grids'], profileDefaults.grids, 10);
      const { low, high, allocation } = resolveGridParams(options, ohlcv, { grids });
      const feeModel = resolveProfiledString(
        options,
        'feeModel',
        ['--fee-model'],
        profileDefaults.feeModel,
        'flat',
        feeDefaults.model
      ).toLowerCase();
      const slippageRate = resolveProfiledNumber(
        options,
        'slippageRate',
        ['--slippage-rate'],
        profileDefaults.slippageRate,
        0,
        feeDefaults.slippageRate
      );
      const feeOptions = resolveFeeOptions(options, { feeModel, slippageRate }, feeDefaults);
      const trailStepPercent = resolveProfiledOptionalNumber(
        options,
        'trailStepPercent',
        ['--trail-step-percent'],
        profileDefaults.trailStepPercent
      );
      const stopOnMa30 = resolveProfiledOptionalBoolean(
        options,
        'stopOnMa30',
        ['--stop-on-ma30'],
        profileDefaults.stopOnMa30
      );
      const stopOnLowCloses = resolveProfiledOptionalNumber(
        options,
        'stopOnLowCloses',
        ['--stop-on-low-closes'],
        profileDefaults.stopOnLowCloses
      );
      formatProfileSummary({
        profile: profileName,
        grids,
        feeModel,
        slippageRate,
        trailStepPercent,
        stopOnMa30,
        stopOnLowCloses,
      });
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
              sourceTimeframe: timeframe,
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
  .option('--profile <profile>', 'Profile name: default|promo|safe', 'default')
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
      const { name: profileName, defaults: profileDefaults } = getProfileDefaults(readStringOption(options, 'profile'));
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

      const grids = resolveProfiledNumber(options, 'grids', ['--grids'], profileDefaults.grids, 10);
      const { low, high, allocation } = resolveGridParams(options, periodCandles, { grids });
      const feeModel = resolveProfiledString(
        options,
        'feeModel',
        ['--fee-model'],
        profileDefaults.feeModel,
        'flat'
      ).toLowerCase();
      const slippageRate = resolveProfiledNumber(
        options,
        'slippageRate',
        ['--slippage-rate'],
        profileDefaults.slippageRate,
        0
      );
      const feeOptions = resolveFeeOptions(options, { feeModel, slippageRate });
      formatProfileSummary({
        profile: profileName,
        grids,
        feeModel,
        slippageRate,
        trailStepPercent: profileDefaults.trailStepPercent,
        stopOnMa30: profileDefaults.stopOnMa30,
        stopOnLowCloses: profileDefaults.stopOnLowCloses,
      });
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
