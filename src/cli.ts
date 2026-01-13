import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Command } from 'commander';
import { fetchOHLCV } from './real/ohlcv';
import { detectRegime } from './core/regime';
import { analyzeLedger, importLedger, LedgerEntry, LedgerFeeMode, LedgerSummary } from './core/importLedger';
import { getProfileDefaults } from './core/profiles';
import { generateCandles } from './simulation/candleGenerator';
import { MarketSimulator } from './simulation/marketSimulator';
import { OrderExecutionEngine } from './simulation/orderExecution';
import { TradeBot } from './simulation/tradeBot';
import { formatSimulationReport } from './simulation/reporter';
import { KucoinClient } from './real/kucoinClient';
import { GateClient } from './real/gateClient';
import { analyzePortfolio } from './real/portfolioAnalyzer';
import { computeIndicators } from './indicators';
import { runAllStrategies, combineSignals } from './strategies';
import { OpenAILlmClient } from './llm/llmClient';
import { aggregateNews } from './news/aggregator';
import { parseReport } from './reports/reportParser';
import { exportReport } from './reports/reportGenerator';
import { validateEnv } from './utils/env';
import { fetchFundingRate } from './indicators/fundingRate';
import { clearOhlcvCache } from './real/exchangeUtils';
import { GridResult, runGridBacktest } from './strategies/gridEngine';
import { backtestTrailingGrid } from './strategies/trailingGrid';
import { FeeDefaults, loadConfig } from './core/config';
import { sma } from './indicators/sma';
import {
  renderAsciiChart,
  renderAsciiChartSeries,
  renderBarChartPNG,
  renderChartPNG,
  renderLineChartPNG,
} from './ui/charts';
import {
  OutputFormat,
  ReportPayload,
  ReportValue,
  formatJsonReport,
  formatMarkdownReport,
  formatTextReport,
  printJsonReport,
  printMarkdownReport,
  printTextReport,
} from './core/output';

const program = new Command();

program
  .name('crypto-ai')
  .description('AI-powered crypto trading assistant with market simulation')
  .addHelpText(
    'after',
    `
Examples:
  $ crypto-ai sim:simulate --symbol TONUSDT --timeframe 1m --candles 200 --initial-price 2.5
  $ crypto-ai sim:trade-sim --symbol TONUSDT --timeframe 1m --candles 500 --initial-price 2.5
  $ crypto-ai analysis:analyze-pair --exchange gate --symbol RAVE/USDT --timeframe 15m
`
  )
  .version('1.0.0');

type OhlcvSource = 'exchange' | 'cache';

interface OutputMetrics {
  pnlGross: number;
  pnlNet: number;
  feesTotal: number;
  feeRatio: number;
  trades: number;
  turnover: number;
}

function normalizeOutputFormat(value: string | undefined): OutputFormat {
  if (value === 'json' || value === 'md' || value === 'text') {
    return value;
  }
  return 'text';
}

function readOutputFormat(options: Record<string, unknown>): OutputFormat {
  return normalizeOutputFormat(readStringOption(options, 'output'));
}

function shouldRenderAsciiPlot(options: Record<string, unknown>, outputFormat: OutputFormat): boolean {
  return outputFormat !== 'json' && readStringOption(options, 'plot') === 'ascii';
}

function shouldRenderPngPlot(options: Record<string, unknown>): boolean {
  return readStringOption(options, 'plot') === 'png';
}

function printAsciiPlot(outputFormat: OutputFormat, title: string, chart: string): void {
  if (outputFormat === 'json') return;
  if (outputFormat === 'md') {
    console.log(`\n${title}\n\n\`\`\`\n${chart}\n\`\`\`\n`);
    return;
  }
  console.log(`\n${title}\n${chart}\n`);
}

function renderReport(format: OutputFormat, report: ReportPayload): void {
  if (format === 'json') {
    printJsonReport(report);
    return;
  }
  if (format === 'md') {
    printMarkdownReport(report);
    return;
  }
  printTextReport(report);
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+/, '').replace(/-+$/, '') || 'unknown';
}

function buildPlotPath(commandName: string, symbol: string, plotName: string): string {
  const now = new Date();
  const dateFolder = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const safeCommand = sanitizeFilePart(commandName);
  const safeSymbol = sanitizeFilePart(symbol);
  const safePlot = sanitizeFilePart(plotName);
  const dir = path.join('reports', dateFolder);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `plot_${safeCommand}_${safeSymbol}_${safePlot}_${timestamp}.png`);
}

function formatReportOutput(format: OutputFormat, report: ReportPayload): string {
  if (format === 'json') {
    return formatJsonReport(report);
  }
  if (format === 'md') {
    return formatMarkdownReport(report);
  }
  return formatTextReport(report);
}

function saveReport(
  commandName: string,
  symbol: string,
  format: OutputFormat,
  report: ReportPayload
): string {
  const now = new Date();
  const dateFolder = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const safeCommand = sanitizeFilePart(commandName);
  const safeSymbol = sanitizeFilePart(symbol);
  const extension = format === 'json' ? 'json' : 'md';
  const dir = path.join('reports', dateFolder);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `report_${safeCommand}_${safeSymbol}_${timestamp}.${extension}`);
  const content = formatReportOutput(format, report);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function renderReportWithSave(
  commandName: string,
  outputFormat: OutputFormat,
  report: ReportPayload,
  options: Record<string, unknown>,
  symbol: string
): void {
  renderReport(outputFormat, report);
  if (options.saveReport) {
    if (outputFormat === 'text') {
      console.error('Saving report requires --output md|json.');
      return;
    }
    const savedPath = saveReport(commandName, symbol, outputFormat, report);
    console.log(`Saved report -> ${savedPath}`);
  }
}

function buildStatusReport(message: string): ReportPayload {
  return {
    title: 'Status',
    sections: [
      {
        title: 'Message',
        rows: {
          message,
        },
      },
    ],
  };
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

function buildHourlyHistogram(entries: LedgerEntry[], quoteCurrency: string): {
  labels: string[];
  trades: number[];
  fees: number[];
} | null {
  const buckets = new Map<number, { trades: number; fees: number }>();

  entries.forEach((entry) => {
    const timestamp = Date.parse(entry.time);
    if (Number.isNaN(timestamp)) {
      return;
    }
    const hourStart = Math.floor(timestamp / 3600000) * 3600000;
    const bucket = buckets.get(hourStart) ?? { trades: 0, fees: 0 };
    if (entry.actionType === 'trade') {
      bucket.trades += 1;
    }
    if (entry.actionType === 'fee' && entry.currency === quoteCurrency) {
      bucket.fees += Math.abs(entry.amount);
    }
    buckets.set(hourStart, bucket);
  });

  if (buckets.size === 0) {
    return null;
  }

  const sortedHours = Array.from(buckets.keys()).sort((a, b) => a - b);
  const labels = sortedHours.map((hour) => {
    const date = new Date(hour);
    return `${date.toISOString().slice(0, 13)}:00`;
  });
  const trades = sortedHours.map((hour) => buckets.get(hour)?.trades ?? 0);
  const fees = sortedHours.map((hour) => buckets.get(hour)?.fees ?? 0);

  if (trades.every((value) => value === 0) && fees.every((value) => value === 0)) {
    return null;
  }

  return { labels, trades, fees };
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

function buildMetricsRows(metrics: OutputMetrics): Record<string, ReportValue> {
  return {
    pnl_gross: metrics.pnlGross.toFixed(4),
    pnl_net: metrics.pnlNet.toFixed(4),
    fees_total: metrics.feesTotal.toFixed(4),
    fee_ratio: metrics.feeRatio.toFixed(6),
    trades: metrics.trades,
    turnover: metrics.turnover.toFixed(4),
  };
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

function buildProfileSummaryRows(params: {
  profile: string;
  grids?: number;
  feeModel?: string;
  slippageRate?: number;
  trailStepPercent?: number;
  stopOnMa30?: boolean;
  stopOnLowCloses?: number;
}): Record<string, ReportValue> {
  return {
    profile: params.profile,
    grids: params.grids ?? null,
    fee_model: params.feeModel ?? null,
    slippage_rate: params.slippageRate ?? null,
    trail_step_percent: params.trailStepPercent ?? null,
    stop_on_ma30: params.stopOnMa30 ?? null,
    stop_on_low_closes: params.stopOnLowCloses ?? null,
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

type WizardGoal = 'profit' | 'turnover';
type WizardRisk = 'safe' | 'default' | 'aggressive';

async function runWithArgv(args: string[], action: () => Promise<void>): Promise<void> {
  const originalArgv = process.argv;
  process.argv = [...originalArgv.slice(0, 2), ...args];
  try {
    await action();
  } finally {
    process.argv = originalArgv;
  }
}

function selectWizardProfile(goal: WizardGoal, risk: WizardRisk): string {
  if (risk === 'safe') {
    return 'safe';
  }
  if (risk === 'aggressive') {
    return 'promo';
  }
  if (goal === 'turnover') {
    return 'promo';
  }
  return 'default';
}

async function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function promptInput(rl: readline.Interface, label: string, defaultValue: string): Promise<string> {
  const answer = (await askQuestion(rl, `${label} [${defaultValue}]: `)).trim();
  return answer || defaultValue;
}

async function promptOptionalInput(
  rl: readline.Interface,
  label: string,
  defaultValue?: string
): Promise<string | undefined> {
  const suffix = defaultValue ? ` [${defaultValue}]` : ' (blank = now)';
  const answer = (await askQuestion(rl, `${label}${suffix}: `)).trim();
  if (answer) {
    return answer;
  }
  return defaultValue || undefined;
}

async function promptChoice<T extends string>(
  rl: readline.Interface,
  label: string,
  choices: readonly T[],
  defaultValue: T
): Promise<T> {
  const normalizedChoices = choices.map((choice) => choice.toLowerCase());
  while (true) {
    const answer = (await askQuestion(rl, `${label} (${choices.join('/')}) [${defaultValue}]: `))
      .trim()
      .toLowerCase();
    const resolved = (answer || defaultValue).toLowerCase();
    const index = normalizedChoices.indexOf(resolved);
    if (index >= 0) {
      return choices[index];
    }
    console.log(`Please enter one of: ${choices.join(', ')}`);
  }
}

async function promptYesNo(rl: readline.Interface, label: string, defaultValue: boolean): Promise<boolean> {
  const defaultToken = defaultValue ? 'y' : 'n';
  while (true) {
    const answer = (await askQuestion(rl, `${label} [${defaultToken}]: `)).trim().toLowerCase();
    const resolved = answer || defaultToken;
    if (resolved === 'y' || resolved === 'yes') {
      return true;
    }
    if (resolved === 'n' || resolved === 'no') {
      return false;
    }
    console.log('Please enter y or n.');
  }
}

async function handleDecide(options: Record<string, unknown>): Promise<void> {
  try {
    const outputFormat = readOutputFormat(options);
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
      renderReportWithSave(
        'decide',
        outputFormat,
        buildStatusReport('No OHLCV data available to decide.'),
        options,
        symbol
      );
      return;
    }
    const slopeWindow = parseNumber(readStringOption(options, 'slopeWindow'), 5);
    const minSlope = parseNumber(readStringOption(options, 'minSlope'), 0.0001);
    const minDistance = parseNumber(readStringOption(options, 'minDistance'), 0.001);
    const regimeResult = detectRegime(ohlcv, { slopeWindow, minSlope, minDistance });
    const confidence = calculateRegimeConfidence(regimeResult, { minSlope, minDistance });

    const strategy =
      regimeResult.regime === 'TREND' ? 'trailing' : regimeResult.regime === 'RANGE' ? 'spot' : 'no-trade';

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
    const recommendationTitle =
      strategy === 'no-trade' ? 'Recommended command (no-trade, for evaluation only)' : 'Recommended command';
    renderReportWithSave(
      'decide',
      outputFormat,
      {
        title: 'Decision report',
        sections: [
          {
            title: 'Regime',
            rows: {
              symbol,
              regime: regimeResult.regime,
              slope: regimeResult.slope.toFixed(6),
              distance: regimeResult.distance.toFixed(6),
              confidence,
            },
          },
          {
            title: 'Strategy',
            rows: {
              strategy,
              recommended_mode: recommendedMode,
            },
          },
          {
            title: 'Profile',
            rows: buildProfileSummaryRows({
              profile: profileName,
              grids: profileDefaults.grids,
              feeModel,
              slippageRate,
              trailStepPercent: profileDefaults.trailStepPercent,
              stopOnMa30: profileDefaults.stopOnMa30,
              stopOnLowCloses: profileDefaults.stopOnLowCloses,
            }),
          },
          {
            title: 'Fees',
            rows: {
              fee_model: feeModel,
              fee_rate: feeInputs.feeRate ?? null,
              maker_fee_rate: feeInputs.makerFeeRate ?? null,
              taker_fee_rate: feeInputs.takerFeeRate ?? null,
              gt_discount_rate: feeInputs.gtDiscountRate ?? null,
              voucher_discount_type: feeInputs.voucherDiscountType ?? null,
              voucher_discount_value: feeInputs.voucherDiscountValue ?? null,
              minimum_fee: feeInputs.minimumFee ?? null,
              fee_rounding_decimals: feeInputs.roundingDecimals ?? null,
              slippage_rate: slippageRate ?? null,
            },
          },
          {
            title: recommendationTitle,
            rows: {
              command: recommendedCommand,
            },
          },
        ],
      },
      options,
      symbol
    );
  } catch (error) {
    console.error('Error deciding strategy:', error);
  }
}

async function handleBacktestGrid(options: Record<string, unknown>): Promise<void> {
  try {
    const outputFormat = readOutputFormat(options);
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
      renderReportWithSave(
        'backtest-grid',
        outputFormat,
        buildStatusReport('No OHLCV data available for backtest.'),
        options,
        symbol
      );
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
    const report = {
      title: 'Grid backtest report',
      sections: [
        {
          title: 'Profile',
          rows: buildProfileSummaryRows({
            profile: profileName,
            grids,
            feeModel,
            slippageRate,
            trailStepPercent,
            stopOnMa30,
            stopOnLowCloses,
          }),
        },
        {
          title: 'Grid backtest metrics',
          rows: buildMetricsRows(buildGridMetrics(gridResult)),
        },
      ],
    };
    if (shouldRenderAsciiPlot(options, outputFormat)) {
      const plotPoints = Math.min(gridResult.equityCurve.length, 120);
      if (plotPoints > 0) {
        const chart = renderAsciiChartSeries([gridResult.equityCurve.slice(-plotPoints)]);
        printAsciiPlot(outputFormat, `Equity curve (last ${plotPoints} points)`, chart);
      }
    }
    if (shouldRenderPngPlot(options)) {
      const priceLabels = ohlcv.map((candle) => new Date(candle.timestamp).toLocaleString());
      const closeSeries = ohlcv.map((candle) => candle.close);
      const ma30Series = sma(closeSeries, 30).map((value) => (Number.isFinite(value) ? value : null));
      const pricePlotPath = buildPlotPath('backtest-grid', symbol, 'price-ma30');
      await renderLineChartPNG(
        priceLabels,
        [
          { label: 'Close', data: closeSeries, borderColor: 'rgba(75,192,192,1)' },
          { label: 'MA30', data: ma30Series, borderColor: 'rgba(255,159,64,1)' },
        ],
        pricePlotPath,
        { title: 'Close + MA30' }
      );
      console.log(`Saved plot -> ${pricePlotPath}`);

      const equityLength = Math.min(gridResult.equityCurve.length, priceLabels.length);
      const equityLabels = priceLabels.slice(0, equityLength);
      const equitySeries = gridResult.equityCurve.slice(0, equityLength);
      const equityPlotPath = buildPlotPath('backtest-grid', symbol, 'equity-curve');
      await renderLineChartPNG(
        equityLabels,
        [{ label: 'Equity', data: equitySeries, borderColor: 'rgba(153,102,255,1)' }],
        equityPlotPath,
        { title: 'Equity curve' }
      );
      console.log(`Saved plot -> ${equityPlotPath}`);
    }
    renderReportWithSave('backtest-grid', outputFormat, report, options, symbol);
  } catch (error) {
    console.error('Error running grid backtest:', error);
  }
}

async function runWizard(): Promise<void> {
  const config = loadConfig();
  const outputDefaults = config.output ?? {};
  const defaultSymbol = config.symbols?.[0] ?? 'RAVE/USDT';
  const defaultSince = outputDefaults.since ?? '2024-01-01';
  const defaultSource: OhlcvSource =
    outputDefaults.ohlcvSource === 'cache' || outputDefaults.ohlcvSource === 'exchange'
      ? outputDefaults.ohlcvSource
      : 'exchange';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const symbol = await promptInput(rl, 'Symbol', defaultSymbol);
    const since = await promptInput(rl, 'Since (ISO)', defaultSince);
    const until = await promptOptionalInput(rl, 'Until (ISO)', outputDefaults.until);
    const goal = await promptChoice(rl, 'Цель', ['profit', 'turnover'] as const, 'profit');
    const risk = await promptChoice(rl, 'Риск', ['safe', 'default', 'aggressive'] as const, 'default');
    const source = await promptChoice(rl, 'Источник OHLCV', ['cache', 'exchange'] as const, defaultSource);
    const profile = selectWizardProfile(goal, risk);
    console.log(`Selected profile: ${profile}`);

    const decideOptions: Record<string, unknown> = {
      symbol,
      since,
      ohlcvSource: source,
      profile,
      output: 'text',
    };
    const decideArgs = ['decide', '--symbol', symbol, '--since', since, '--ohlcv-source', source, '--profile', profile];
    if (until) {
      decideOptions.until = until;
      decideArgs.push('--until', until);
    }
    await runWithArgv(decideArgs, () => handleDecide(decideOptions));

    const shouldRunBacktest = await promptYesNo(rl, 'Запустить backtest-grid? (y/n)', false);
    if (shouldRunBacktest) {
      const backtestOptions: Record<string, unknown> = {
        symbol,
        since,
        ohlcvSource: source,
        profile,
        output: 'text',
      };
      const backtestArgs = [
        'backtest-grid',
        '--symbol',
        symbol,
        '--since',
        since,
        '--ohlcv-source',
        source,
        '--profile',
        profile,
      ];
      if (until) {
        backtestOptions.until = until;
        backtestArgs.push('--until', until);
      }
      await runWithArgv(backtestArgs, () => handleBacktestGrid(backtestOptions));
    }
  } finally {
    rl.close();
  }
}

program
  .addHelpText(
    'after',
    `
Examples:
  $ npm start -- analysis:analyze-regime --exchange gate --symbol RAVE/USDT --since 2024-01-01
  $ npm start -- backtest-grid --symbol RAVE/USDT --since 2024-01-01 --mode spot
  $ npm start -- compare --ledger ./data/ledger.csv --symbol RAVE/USDT
  $ npm start -- decide --profile promo --symbol RAVE/USDT
`
  )
  .command('data:fetch-ohlcv')
  .option('--exchange <exchange>', 'Exchange ID', 'gate')
  .option('--symbol <symbol>', 'Symbol', 'RAVE/USDT')
  .option('--timeframe <timeframe>', 'Timeframe', '1m')
  .option('--since <since>', 'Start date (ISO)', '2025-12-12')
  .option('--until <until>', 'End date (ISO)')
  .option('--limit <limit>', 'Max candles', '1000')
  .option('--rebuild', 'Rebuild cache', false)
  .addHelpText(
    'after',
    `
Examples:
  $ npm start -- data:fetch-ohlcv --exchange gate --symbol RAVE/USDT --timeframe 1m --since 2024-01-01
  $ npm start -- data:fetch-ohlcv --symbol BTC/USDT --timeframe 1h --since 2024-06-01 --limit 500 --rebuild
`
  )
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
  .command('analysis:analyze-regime')
  .option('--exchange <exchange>', 'Exchange ID', 'gate')
  .option('--symbol <symbol>', 'Symbol', 'RAVE/USDT')
  .option('--since <since>', 'Start date (ISO)', '2024-01-01')
  .option('--until <until>', 'End date (ISO)')
  .option('--limit <limit>', 'Max candles', '1000')
  .option('--slope-window <number>', 'MA30 slope window', '5')
  .option('--min-slope <number>', 'Minimum MA30 slope to confirm trend', '0.0001')
  .option('--min-distance <number>', 'Minimum price distance to MA30', '0.001')
  .option('--plot <type>', 'Plot type: ascii')
  .option('--output <format>', 'Output format: text|json|md', 'text')
  .option('--save-report', 'Save report to file')
  .addHelpText(
    'after',
    `
Examples:
  $ npm start -- analysis:analyze-regime --exchange gate --symbol RAVE/USDT --since 2024-01-01
  $ npm start -- analysis:analyze-regime --symbol BTC/USDT --since 2023-10-01 --output md --save-report
`
  )
  .action(async (options) => {
    const outputFormat = readOutputFormat(options);
    const limit = parseInt(options.limit, 10);
    const ohlcv = await fetchOHLCV(options.exchange, options.symbol, '15m', options.since, limit, {
      rebuildCache: false,
      until: options.until,
    });
    if (!ohlcv.length) {
      renderReportWithSave(
        'analysis:analyze-regime',
        outputFormat,
        buildStatusReport('No OHLCV data available to analyze regime.'),
        options,
        options.symbol
      );
      return;
    }
    const parsedSlopeWindow = Number(options.slopeWindow);
    const slopeWindow = Number.isFinite(parsedSlopeWindow) ? parsedSlopeWindow : 5;
    const parsedMinSlope = Number(options.minSlope);
    const minSlope = Number.isFinite(parsedMinSlope) ? parsedMinSlope : 0;
    const parsedMinDistance = Number(options.minDistance);
    const minDistance = Number.isFinite(parsedMinDistance) ? parsedMinDistance : 0;
    const { regime, slope, distance } = detectRegime(ohlcv, { slopeWindow, minSlope, minDistance });
    const periodStart = ohlcv.length ? new Date(ohlcv[0].timestamp).toISOString() : 'n/a';
    const periodEnd = ohlcv.length ? new Date(ohlcv[ohlcv.length - 1].timestamp).toISOString() : 'n/a';
    const report = {
      title: 'Regime analysis',
      sections: [
        {
          title: 'Summary',
          rows: {
            symbol: options.symbol,
            regime,
            slope: slope.toFixed(6),
            distance: distance.toFixed(6),
            timeframe: '15m',
            period_start: periodStart,
            period_end: periodEnd,
          },
        },
      ],
    };
    if (shouldRenderAsciiPlot(options, outputFormat)) {
      const closes = ohlcv.map((candle) => candle.close);
      const ma30Series = sma(closes, 30).map((value, index) =>
        Number.isFinite(value) ? value : closes[index]
      );
      const plotPoints = Math.min(ohlcv.length, 120);
      const chart = renderAsciiChartSeries([
        closes.slice(-plotPoints),
        ma30Series.slice(-plotPoints),
      ]);
      printAsciiPlot(outputFormat, `Close + MA30 (last ${plotPoints} points)`, chart);
    }
    renderReportWithSave('analysis:analyze-regime', outputFormat, report, options, options.symbol);
  });

program
  .command('analysis:analyze-pair')
  .description('Analyze a real trading pair')
  .addHelpText(
    'after',
    `
Examples:
  $ crypto-ai analysis:analyze-pair --exchange gate --symbol RAVE/USDT --timeframe 15m
  $ crypto-ai analysis:analyze-pair --exchange kucoin --symbol BTC/USDT --timeframe 1h --months 3
`
  )
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
        const funding = await fetchFundingRate((client as any).exchange ?? (client as any), options.symbol).catch(
          () => null
        );
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
  .command('analysis:analyze-portfolio')
  .description('Analyze portfolio across exchanges')
  .addHelpText(
    'after',
    `
Examples:
  $ crypto-ai analysis:analyze-portfolio
  $ crypto-ai analysis:analyze-portfolio --no-llm
`
  )
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
  .command('analysis:analyze-news')
  .description('Analyze news and signals')
  .addHelpText(
    'after',
    `
Examples:
  $ crypto-ai analysis:analyze-news
  $ crypto-ai analysis:analyze-news --symbol BTC
`
  )
  .option('--symbol <string>', 'Filter by symbol')
  .action(async (options) => {
    console.log('\nFetching news and signals...\n');

    try {
      const news = await aggregateNews(options.symbol);

      console.log(`Found ${news.length} items:\n`);
      news.forEach((item) => {
        console.log(`${item.title}`);
        console.log(`  Sentiment: ${item.sentiment} | Source: ${item.source} | Link: ${item.rawLink ?? 'n/a'}`);
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

program
  .command('sim:simulate')
  .description('Generate artificial candles and display statistics')
  .addHelpText(
    'after',
    `
Examples:
  $ crypto-ai sim:simulate --symbol TONUSDT --timeframe 1m --candles 200 --initial-price 2.5
  $ crypto-ai sim:simulate --symbol BTCUSDT --timeframe 15m --candles 96 --initial-price 64000 --volatility 0.03
`
  )
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
  .command('sim:trade-sim')
  .description('Run AI TradeBot simulation')
  .addHelpText(
    'after',
    `
Examples:
  $ crypto-ai sim:trade-sim --symbol TONUSDT --timeframe 1m --candles 300 --initial-price 2.5
  $ crypto-ai sim:trade-sim --symbol BTCUSDT --timeframe 5m --candles 500 --initial-price 64000 --save-chart
`
  )
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
      execution
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
            maxDrawdownPercent: report.maxDrawdownPercent,
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
  .command('wizard')
  .description('Interactive wizard to run decide and optionally backtest-grid.')
  .addHelpText(
    'after',
    `
Examples:
  $ npm start -- wizard
`
  )
  .action(async () => {
    await runWizard();
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
  .option('--output <format>', 'Output format: text|json|md', 'text')
  .option('--save-report', 'Save report to file')
  .addHelpText(
    'after',
    `
Examples:
  $ npm start -- decide --symbol RAVE/USDT --since 2024-01-01
  $ npm start -- decide --profile promo --symbol RAVE/USDT --output md --save-report
`
  )
  .action(async (options) => {
    await handleDecide(options);
  });

program
  .command('ledger:import-ledger')
  .argument('<file>', 'Path to CSV file')
  .option('--exchange <exchange>', 'Exchange ID', 'gate')
  .option('--symbol <symbol>', 'Symbol', 'RAVE/USDT')
  .option('--timeframe <timeframe>', 'Timeframe', '1m')
  .option('--ohlcv-source <source>', 'OHLCV source: exchange|cache', 'exchange')
  .option('--ohlcv-limit <limit>', 'Max candles', '10000')
  .option('--ledger-fee-mode <mode>', 'Ledger fee mode: separate|ohlcv', 'separate')
  .option('--output <format>', 'Output format: text|json|md', 'text')
  .option('--save-report', 'Save report to file')
  .addHelpText(
    'after',
    `
Examples:
  $ npm start -- ledger:import-ledger ./data/ledger.csv --symbol RAVE/USDT
  $ npm start -- ledger:import-ledger ./data/ledger.csv --symbol RAVE/USDT --ledger-fee-mode ohlcv --output md
`
  )
  .action(async (file, options) => {
      try {
        const outputFormat = readOutputFormat(options);
        const entries = importLedger(file);
        const feeMode = readLedgerFeeMode(options);
        const gtFeeResolution =
          feeMode === 'ohlcv' ? await resolveGtFeeQuoteResolver(entries, options) : { resolver: undefined, ohlcvCount: 0 };
        const gtFeeQuoteResolver = gtFeeResolution.resolver;
        const summary = analyzeLedger(entries, { feeMode, gtFeeQuoteResolver });
        if (!summary.startTime || !summary.endTime) {
          renderReportWithSave(
            'ledger:import-ledger',
            outputFormat,
            buildStatusReport('Not enough trade data to build a report.'),
            options,
            options.symbol
          );
          return;
        }

        const { metrics: ledgerMetrics, feesBreakdown } = buildLedgerMetrics(summary);

        const report = {
          title: 'Ledger import report',
          sections: [
            {
              title: 'Ledger summary',
              rows: {
                entries: entries.length,
                period_start: summary.startTime.toISOString(),
                period_end: summary.endTime.toISOString(),
                avg_profit_per_trade_quote: summary.avgProfitPerTrade.toFixed(4),
                trades_per_hour: summary.tradesPerHour.toFixed(2),
                fee_mode: summary.feeMode,
                gt_fee_quote_available: summary.feeMode === 'ohlcv' ? Boolean(gtFeeQuoteResolver) : null,
                fees_total_quote: summary.totalFeesInQuote.toFixed(6),
                fees_total_gt: summary.totalFeesInGt.toFixed(6),
                gt_fees_quote: summary.feeMode === 'ohlcv' ? summary.gtFeeInQuote.toFixed(6) : null,
                fees_total_quote_equiv:
                  summary.feeMode === 'ohlcv' ? summary.totalFeesInQuoteWithGt.toFixed(6) : null,
                gt_fee_price_missing: summary.feeMode === 'ohlcv' ? summary.gtFeeMissingCount : null,
                fees_breakdown: feesBreakdown || 'n/a',
              },
            },
            {
              title: 'Ledger metrics',
              rows: buildMetricsRows(ledgerMetrics),
            },
          ],
        };
        renderReportWithSave('ledger:import-ledger', outputFormat, report, options, options.symbol);
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
  .option('--plot <type>', 'Plot type: ascii|png')
  .option('--output <format>', 'Output format: text|json|md', 'text')
  .option('--save-report', 'Save report to file')
  .addHelpText(
    'after',
    `
Examples:
  $ npm start -- backtest-grid --symbol RAVE/USDT --since 2024-01-01 --mode spot
  $ npm start -- backtest-grid --profile promo --symbol RAVE/USDT --mode trailing --plot ascii
`
  )
  .action(async (options) => {
    await handleBacktestGrid(options);
  });

program
  .command('compare')
  .requiredOption('--ledger <file>', 'Path to CSV file')
  .option('--profile <profile>', 'Profile name: default|promo|safe', 'default')
  .option('--exchange <exchange>', 'Exchange ID', 'gate')
  .option('--symbol <symbol>', 'Symbol', 'RAVE/USDT')
  .option('--timeframe <timeframe>', 'Timeframe', '1m')
  .option('--since <since>', 'Start date (ISO)')
  .option('--until <until>', 'End date (ISO)')
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
  .option('--ohlcv-source <source>', 'OHLCV source: exchange|cache', 'cache')
  .option('--ohlcv-limit <limit>', 'Max candles', '10000')
  .option('--ledger-fee-mode <mode>', 'Ledger fee mode: separate|ohlcv', 'separate')
  .option('--plot <type>', 'Plot type: png')
  .option('--output <format>', 'Output format: text|json|md', 'text')
  .option('--save-report', 'Save report to file')
  .addHelpText(
    'after',
    `
Examples:
  $ npm start -- compare --ledger ./data/ledger.csv --symbol RAVE/USDT
  $ npm start -- compare --ledger ./data/ledger.csv --profile promo --symbol RAVE/USDT --plot png
`
  )
  .action(async (options) => {
    try {
      const outputFormat = readOutputFormat(options);
      const symbol = readStringOption(options, 'symbol') ?? 'RAVE/USDT';
      const { name: profileName, defaults: profileDefaults } = getProfileDefaults(readStringOption(options, 'profile'));
      const ledgerPath = readStringOption(options, 'ledger');
      if (!ledgerPath) {
        throw new Error('Ledger path is required. Use --ledger <file>.');
      }
      const entries = importLedger(ledgerPath);
      const feeMode = readLedgerFeeMode(options);
      const gtFeeResolution =
        feeMode === 'ohlcv' ? await resolveGtFeeQuoteResolver(entries, options) : { resolver: undefined, ohlcvCount: 0 };
      const gtFeeQuoteResolver = gtFeeResolution.resolver;
      const summary = analyzeLedger(entries, { feeMode, gtFeeQuoteResolver });
      if (!summary.startTime || !summary.endTime) {
        renderReportWithSave(
          'compare',
          outputFormat,
          buildStatusReport('Not enough trade data to build a report.'),
          options,
          symbol
        );
        return;
      }

      const { metrics: ledgerMetrics, feesBreakdown } = buildLedgerMetrics(summary);

      const sinceOption = readStringOption(options, 'since');
      const untilOption = readStringOption(options, 'until');
      const backtestSince = sinceOption ?? summary.startTime.toISOString();
      const backtestUntil = untilOption ?? summary.endTime.toISOString();
      const ohlcv = await resolveOhlcv({
        exchange: options.exchange,
        symbol,
        timeframe: options.timeframe,
        since: backtestSince,
        until: backtestUntil,
        ohlcvSource: options.ohlcvSource,
        ohlcvLimit: options.ohlcvLimit,
      });
      if (!ohlcv.length) {
        renderReportWithSave(
          'compare',
          outputFormat,
          buildStatusReport('No OHLCV data available for the requested period.'),
          options,
          symbol
        );
        return;
      }
      const startTimeMs = Date.parse(backtestSince);
      const endTimeMs = Date.parse(backtestUntil);
      const periodCandles = ohlcv.filter((candle) => {
        if (Number.isFinite(startTimeMs) && candle.timestamp < startTimeMs) {
          return false;
        }
        if (Number.isFinite(endTimeMs) && candle.timestamp > endTimeMs) {
          return false;
        }
        return true;
      });
      if (!periodCandles.length) {
        renderReportWithSave(
          'compare',
          outputFormat,
          buildStatusReport('No OHLCV data available for the requested period.'),
          options,
          symbol
        );
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
      const gridResult = runGridBacktest({
        ohlcv: periodCandles,
        low,
        high,
        grids,
        allocation,
        ...feeOptions,
      });

      const report = {
        title: 'Ledger comparison report',
        sections: [
          {
            title: 'Ledger summary',
            rows: {
              entries: entries.length,
              period_start: summary.startTime.toISOString(),
              period_end: summary.endTime.toISOString(),
              fee_mode: summary.feeMode,
              gt_fee_quote_available: summary.feeMode === 'ohlcv' ? Boolean(gtFeeQuoteResolver) : null,
              fees_total_quote: summary.totalFeesInQuote.toFixed(6),
              fees_total_gt: summary.totalFeesInGt.toFixed(6),
              gt_fees_quote: summary.feeMode === 'ohlcv' ? summary.gtFeeInQuote.toFixed(6) : null,
              fees_total_quote_equiv:
                summary.feeMode === 'ohlcv' ? summary.totalFeesInQuoteWithGt.toFixed(6) : null,
              gt_fee_price_missing: summary.feeMode === 'ohlcv' ? summary.gtFeeMissingCount : null,
              fees_breakdown: feesBreakdown || 'n/a',
            },
          },
          {
            title: 'Backtest window',
            rows: {
              since: backtestSince,
              until: backtestUntil,
              ohlcv_source: options.ohlcvSource,
            },
          },
          {
            title: 'Ledger metrics',
            rows: buildMetricsRows(ledgerMetrics),
          },
          {
            title: 'Profile',
            rows: buildProfileSummaryRows({
              profile: profileName,
              grids,
              feeModel,
              slippageRate,
              trailStepPercent: profileDefaults.trailStepPercent,
              stopOnMa30: profileDefaults.stopOnMa30,
              stopOnLowCloses: profileDefaults.stopOnLowCloses,
            }),
          },
          {
            title: 'Grid backtest metrics',
            rows: buildMetricsRows(buildGridMetrics(gridResult)),
          },
          {
            title: 'PnL delta',
            rows: {
              ledger_net_minus_grid_net: (ledgerMetrics.pnlNet - gridResult.pnlNet).toFixed(4),
            },
          },
        ],
      };
      if (shouldRenderPngPlot(options)) {
        const priceLabels = periodCandles.map((candle) => new Date(candle.timestamp).toLocaleString());
        const closeSeries = periodCandles.map((candle) => candle.close);
        const ma30Series = sma(closeSeries, 30).map((value) => (Number.isFinite(value) ? value : null));
        const pricePlotPath = buildPlotPath('compare', symbol, 'price-ma30');
        await renderLineChartPNG(
          priceLabels,
          [
            { label: 'Close', data: closeSeries, borderColor: 'rgba(75,192,192,1)' },
            { label: 'MA30', data: ma30Series, borderColor: 'rgba(255,159,64,1)' },
          ],
          pricePlotPath,
          { title: 'Close + MA30' }
        );
        console.log(`Saved plot -> ${pricePlotPath}`);

        const equityLength = Math.min(gridResult.equityCurve.length, priceLabels.length);
        const equityLabels = priceLabels.slice(0, equityLength);
        const equitySeries = gridResult.equityCurve.slice(0, equityLength);
        const equityPlotPath = buildPlotPath('compare', symbol, 'equity-curve');
        await renderLineChartPNG(
          equityLabels,
          [{ label: 'Equity', data: equitySeries, borderColor: 'rgba(153,102,255,1)' }],
          equityPlotPath,
          { title: 'Equity curve' }
        );
        console.log(`Saved plot -> ${equityPlotPath}`);

        const quoteCurrency = symbol.split('/')[1] ?? '';
        const histogram = quoteCurrency ? buildHourlyHistogram(entries, quoteCurrency) : null;
        if (histogram) {
          const histogramPath = buildPlotPath('compare', symbol, 'fees-trades-per-hour');
          await renderBarChartPNG(
            histogram.labels,
            [
              { label: 'Trades / hour', data: histogram.trades, backgroundColor: 'rgba(54,162,235,0.6)' },
              { label: `Fees / hour (${quoteCurrency})`, data: histogram.fees, backgroundColor: 'rgba(255,99,132,0.6)' },
            ],
            histogramPath,
            { title: 'Fees + Trades per hour' }
          );
          console.log(`Saved plot -> ${histogramPath}`);
        }
      }
      renderReportWithSave('compare', outputFormat, report, options, symbol);
    } catch (error) {
      console.error('Error comparing ledger to backtest:', error);
    }
  });

validateEnv([
  'KUCOIN_API_KEY',
  'KUCOIN_API_SECRET',
  'KUCOIN_API_PASSPHRASE',
  'GATE_API_KEY',
  'GATE_API_SECRET',
  'DEEPSEEK_API_KEY',
]);
program.parse(process.argv);
