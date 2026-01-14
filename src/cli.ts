import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import ccxt, { Exchange } from 'ccxt';
import { Command } from 'commander';
import { detectRegime } from './core/regime';
import { analyzeLedger, importLedger, LedgerEntry, LedgerFeeMode, LedgerSummary } from './core/importLedger';
import { getProfileDefaults } from './core/profiles';
import { generateCandles } from './simulation/candleGenerator';
import { MarketSimulator } from './simulation/marketSimulator';
import { OrderExecutionEngine } from './simulation/orderExecution';
import { TradeBot } from './simulation/tradeBot';
import { SimulationReport } from './simulation/reporter';
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
import { createExchangeOptions } from './real/exchangeUtils';
import { GridResult, runGridBacktest } from './strategies/gridEngine';
import { backtestTrailingGrid } from './strategies/trailingGrid';
import { AppConfig, FeeDefaults, OhlcvSource, loadConfig, resolveConfigPath } from './core/config';
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
import { resolveOhlcv } from './real/resolveOhlcv';

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

function normalizePlotType(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function shouldRenderAsciiPlot(options: Record<string, unknown>, outputFormat: OutputFormat): boolean {
  return outputFormat !== 'json' && normalizePlotType(readStringOption(options, 'plot')) === 'ascii';
}

function shouldRenderPngPlot(options: Record<string, unknown>, outputFormat: OutputFormat): boolean {
  return outputFormat !== 'json' && normalizePlotType(readStringOption(options, 'plot')) === 'png';
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
  const extension = format === 'json' ? 'json' : format === 'md' ? 'md' : 'txt';
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

function buildSimulationReportPayload(symbol: string, timeframe: string, report: SimulationReport): ReportPayload {
  return {
    title: 'Simulation report',
    sections: [
      {
        title: 'Summary',
        rows: {
          symbol,
          timeframe,
          initial_balance: report.initialBalance.toFixed(2),
          final_balance: report.finalBalance.toFixed(2),
          pnl: report.pnl.toFixed(2),
          pnl_percent: report.pnlPercent.toFixed(2),
          trades: report.trades,
          liquidations: report.liquidations,
          max_drawdown_percent: report.maxDrawdownPercent.toFixed(2),
        },
      },
      {
        title: 'Trade log',
        rows: {
          entries: report.log.length,
          log: report.log.join('\n'),
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

function readBooleanOption(options: Record<string, unknown>, key: string): boolean | undefined {
  const value = options[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return parseOptionalBoolean(value);
  }
  return undefined;
}

function resolveRateLimit(options: Record<string, unknown>): boolean {
  const resolved = readBooleanOption(options, 'rateLimit');
  return resolved ?? true;
}

function resolveOhlcvLogOptions(options: Record<string, unknown>): { verbose: boolean; log: (msg: string) => void } {
  const quiet = readBooleanOption(options, 'quiet') ?? false;
  const verbose = readBooleanOption(options, 'verbose') ?? false;
  const log = quiet ? () => {} : console.log;
  return { verbose: !quiet && verbose, log };
}

function createCcxtExchange(exchangeId: string, options: Record<string, unknown>): Exchange {
  const ExchangeCtor = (ccxt as any)[exchangeId];
  if (!ExchangeCtor) {
    throw new Error(`Unsupported exchange: ${exchangeId}`);
  }
  return new ExchangeCtor(
    createExchangeOptions({
      enableRateLimit: resolveRateLimit(options),
    })
  );
}

function resolveConfigInfo(options: Record<string, unknown>): {
  config: AppConfig;
  configPath: string;
  configExists: boolean;
  configSource: 'cli' | 'default';
} {
  const configOption = readStringOption(options, 'config');
  const configSource = configOption ? 'cli' : 'default';
  const { path: configPath, exists: configExists } = resolveConfigPath(configOption);
  const config = loadConfig(configOption);
  return { config, configPath, configExists, configSource };
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

function resolveProfiledOptionalString(
  options: Record<string, unknown>,
  key: string,
  flags: string[],
  profileValue: string | undefined,
  configValue?: string
): string | undefined {
  const raw = readStringOption(options, key);
  if (isFlagSet(flags)) {
    return raw;
  }
  if (profileValue !== undefined) {
    return profileValue;
  }
  if (configValue !== undefined) {
    return configValue;
  }
  return raw;
}

function resolveFeeInputs(
  options: Record<string, unknown>,
  defaults: FeeDefaults,
  profileDefaults?: FeeDefaults,
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
  const feeRate = resolveProfiledNumber(
    options,
    'feeRate',
    ['--fee-rate'],
    profileDefaults?.feeRate,
    0.002,
    defaults.feeRate
  );
  const makerFeeRate = resolveProfiledNumber(
    options,
    'makerFeeRate',
    ['--maker-fee-rate'],
    profileDefaults?.makerFeeRate,
    0.001,
    defaults.makerFeeRate
  );
  const takerFeeRate = resolveProfiledNumber(
    options,
    'takerFeeRate',
    ['--taker-fee-rate'],
    profileDefaults?.takerFeeRate,
    0.002,
    defaults.takerFeeRate
  );
  const gtDiscountRate = resolveProfiledNumber(
    options,
    'gtDiscountRate',
    ['--gt-discount-rate'],
    profileDefaults?.gtDiscountRate,
    0,
    defaults.gtDiscountRate
  );
  const voucherDiscountType = resolveProfiledOptionalString(
    options,
    'voucherDiscountType',
    ['--voucher-discount-type'],
    profileDefaults?.voucherDiscountType,
    defaults.voucherDiscountType
  );
  const voucherDiscountValue = resolveProfiledOptionalNumber(
    options,
    'voucherDiscountValue',
    ['--voucher-discount-value'],
    profileDefaults?.voucherDiscountValue,
    defaults.voucherDiscountValue
  );
  const minimumFee = resolveProfiledNumber(
    options,
    'minimumFee',
    ['--minimum-fee'],
    profileDefaults?.minimumFee,
    0,
    defaults.minimumFee
  );
  const roundingDecimals = resolveProfiledOptionalNumber(
    options,
    'feeRoundingDecimals',
    ['--fee-rounding-decimals'],
    profileDefaults?.roundingDecimals,
    defaults.roundingDecimals
  );
  const slippageRate =
    slippageRateOverride ??
    resolveProfiledNumber(
      options,
      'slippageRate',
      ['--slippage-rate'],
      profileDefaults?.slippageRate,
      0,
      defaults.slippageRate
    );
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
    'npm start -- backtest-grid',
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
    exchange: readStringOption(options, 'exchange') ?? 'gate',
    symbol: 'GT/USDT',
    timeframe: readStringOption(options, 'timeframe') ?? '1m',
    since,
    until,
    source: (readStringOption(options, 'ohlcvSource') as OhlcvSource) ?? 'auto',
    limit: parseNumber(readStringOption(options, 'ohlcvLimit'), 10000),
    rebuildCache: readBooleanOption(options, 'rebuildCache'),
    fillGaps: readBooleanOption(options, 'fillGaps'),
    rateLimit: resolveRateLimit(options),
    ...resolveOhlcvLogOptions(options),
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

function buildGridMetricsRows(result: GridResult): Record<string, ReportValue> {
  return {
    pnl: result.pnlNet.toFixed(4),
    maxDD: result.maxDD.toFixed(4),
    trades: result.tradesCount,
    turnover: result.turnover.toFixed(4),
    fees: result.feesTotal.toFixed(4),
    fee_ratio: result.feeRatio.toFixed(6),
  };
}

function resolveGridParams(
  options: Record<string, unknown>,
  candles: { low: number; high: number }[],
  overrides?: { grids?: number; allocation?: number }
): { low: number; high: number; grids: number; allocation: number } {
  const gridLow = readStringOption(options, 'low') ?? readStringOption(options, 'gridLow');
  const gridHigh = readStringOption(options, 'high') ?? readStringOption(options, 'gridHigh');
  const gridsOption = readStringOption(options, 'grids');
  const allocationOption = readStringOption(options, 'allocation');
  const resolveBound = (value: string | undefined, fallback: number, label: string): number => {
    if (!value) return fallback;
    if (value.toLowerCase() === 'auto') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid grid ${label} value "${value}". Use a number or "auto".`);
    }
    return parsed;
  };
  const low = resolveBound(gridLow, Math.min(...candles.map((c) => c.low)), 'low');
  const high = resolveBound(gridHigh, Math.max(...candles.map((c) => c.high)), 'high');
  const grids = overrides?.grids ?? parseNumber(gridsOption, 10);
  const allocation = overrides?.allocation ?? parseNumber(allocationOption, 1000);
  return { low, high, grids, allocation };
}

function buildFeeOptions(feeModel: string, feeInputs: ReturnType<typeof resolveFeeInputs>): GridFeeOptions {
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

function buildConfigSummaryRows(params: {
  configPath: string;
  configExists: boolean;
  configSource: 'cli' | 'default';
}): Record<string, ReportValue> {
  return {
    config_path: params.configExists ? params.configPath : 'none',
    config_source: params.configSource,
    config_loaded: params.configExists,
  };
}

function buildFeeSummaryRows(
  feeModel: string,
  feeInputs: ReturnType<typeof resolveFeeInputs>
): Record<string, ReportValue> {
  return {
    fee_model: feeModel,
    fee_rate: feeInputs.feeRate ?? null,
    maker_fee_rate: feeInputs.makerFeeRate ?? null,
    taker_fee_rate: feeInputs.takerFeeRate ?? null,
    gt_discount_rate: feeInputs.gtDiscountRate ?? null,
    voucher_discount_type: feeInputs.voucherDiscountType ?? null,
    voucher_discount_value: feeInputs.voucherDiscountValue ?? null,
    minimum_fee: feeInputs.minimumFee ?? null,
    fee_rounding_decimals: feeInputs.roundingDecimals ?? null,
    slippage_rate: feeInputs.slippageRate ?? null,
  };
}

function buildBacktestParamRows(params: {
  grids: number;
  low: number;
  high: number;
  allocation: number;
  trailStepPercent?: number;
  stopOnMa30?: boolean;
  maTimeframe?: string;
  stopOnLowCloses?: number;
}): Record<string, ReportValue> {
  return {
    grids: params.grids,
    grid_low: params.low,
    grid_high: params.high,
    allocation: params.allocation,
    trail_step_percent: params.trailStepPercent ?? null,
    stop_on_ma30: params.stopOnMa30 ?? null,
    ma_timeframe: params.maTimeframe ?? null,
    stop_on_low_closes: params.stopOnLowCloses ?? null,
  };
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
    const { config, configPath, configExists, configSource } = resolveConfigInfo(options);
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
      'auto'
    );
    const { name: profileName, defaults: profileDefaults } = getProfileDefaults(readStringOption(options, 'profile'));
    const decisionTimeframe = '15m';
    const ohlcvLogOptions = resolveOhlcvLogOptions(options);
    const ohlcv = await resolveOhlcv({
      exchange,
      symbol,
      timeframe: decisionTimeframe,
      since,
      until,
      limit,
      source: ohlcvSource as OhlcvSource,
      rebuildCache: readBooleanOption(options, 'rebuildCache'),
      fillGaps: readBooleanOption(options, 'fillGaps'),
      rateLimit: resolveRateLimit(options),
      ...ohlcvLogOptions,
    });
    if (!ohlcv.length) {
      renderReportWithSave(
        'decide',
        outputFormat,
        {
          title: 'Status',
          sections: [
            {
              title: 'Config',
              rows: buildConfigSummaryRows({ configPath, configExists, configSource }),
            },
            {
              title: 'Profile',
              rows: buildProfileSummaryRows({ profile: profileName }),
            },
            {
              title: 'Message',
              rows: { message: 'No OHLCV data available to decide.' },
            },
          ],
        },
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

    const strategyPlan =
      regimeResult.regime === 'TREND'
        ? { label: 'trailing grid', mode: 'trailing' }
        : regimeResult.regime === 'RANGE'
          ? { label: 'spot grid', mode: 'spot' }
          : { label: 'no-trade', mode: undefined };

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
    const feeInputs = resolveFeeInputs(options, feeDefaults, profileDefaults, slippageRate);
    const recommendedMode = strategyPlan.mode ?? 'spot';
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
      strategyPlan.label === 'no-trade'
        ? 'Recommended command (no-trade, for evaluation only)'
        : 'Recommended command';
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
              ohlcv_timeframe: decisionTimeframe,
              regime: regimeResult.regime,
              slope: regimeResult.slope.toFixed(6),
              distance: regimeResult.distance.toFixed(6),
              confidence,
            },
          },
        {
          title: 'Strategy',
          rows: {
            strategy: strategyPlan.label,
            recommended_mode: recommendedMode,
          },
        },
        {
          title: 'Config',
          rows: buildConfigSummaryRows({ configPath, configExists, configSource }),
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
            rows: buildFeeSummaryRows(feeModel, feeInputs),
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
    const { config, configPath, configExists, configSource } = resolveConfigInfo(options);
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
      'auto'
    );
    const mode = resolveConfigString(options, 'mode', ['--mode'], outputDefaults.mode, 'spot').toLowerCase();
    const { name: profileName, defaults: profileDefaults } = getProfileDefaults(readStringOption(options, 'profile'));
    const ohlcvLogOptions = resolveOhlcvLogOptions(options);
    const ohlcv = await resolveOhlcv({
      exchange,
      symbol,
      timeframe,
      since,
      until,
      limit,
      source: ohlcvSource as OhlcvSource,
      rebuildCache: readBooleanOption(options, 'rebuildCache'),
      fillGaps: readBooleanOption(options, 'fillGaps'),
      rateLimit: resolveRateLimit(options),
      ...ohlcvLogOptions,
    });
    if (!ohlcv.length) {
      renderReportWithSave(
        'backtest-grid',
        outputFormat,
        {
          title: 'Status',
          sections: [
            {
              title: 'Config',
              rows: buildConfigSummaryRows({ configPath, configExists, configSource }),
            },
            {
              title: 'Profile',
              rows: buildProfileSummaryRows({ profile: profileName }),
            },
            {
              title: 'Message',
              rows: { message: 'No OHLCV data available for backtest.' },
            },
          ],
        },
        options,
        symbol
      );
      return;
    }
    if (mode !== 'spot' && mode !== 'trailing') {
      throw new Error(`Unsupported mode "${mode}". Use spot or trailing.`);
    }

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
    const feeInputs = resolveFeeInputs(options, feeDefaults, profileDefaults, slippageRate);
    const feeOptions = buildFeeOptions(feeModel, feeInputs);
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
    const maTimeframeInput = (readStringOption(options, 'maTimeframe') ?? '15m').toLowerCase();
    const maTimeframe = maTimeframeInput === 'native' ? 'native' : '15m';
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
      maTimeframe,
      stopOnLowCloses,
    };
    const gridResult =
      mode === 'trailing'
        ? backtestTrailingGrid({
            ...commonOptions,
            sourceTimeframe: timeframe,
            trailStepPercent: trailStepPercent ?? 0,
            stopOnMa30,
            maTimeframe,
            stopOnLowCloses,
          })
        : runGridBacktest(commonOptions);
    const report = {
      title: 'Grid backtest report',
      sections: [
        {
          title: 'Config',
          rows: buildConfigSummaryRows({ configPath, configExists, configSource }),
        },
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
          title: 'Parameters',
          rows: buildBacktestParamRows({
            grids,
            low,
            high,
            allocation,
            trailStepPercent,
            stopOnMa30,
            maTimeframe,
            stopOnLowCloses,
          }),
        },
        {
          title: 'Fees',
          rows: buildFeeSummaryRows(feeModel, feeInputs),
        },
        {
          title: 'Grid backtest metrics',
          rows: buildGridMetricsRows(gridResult),
        },
      ],
    };
    if (shouldRenderAsciiPlot(options, outputFormat)) {
      const plotPoints = Math.min(ohlcv.length, 120);
      if (plotPoints > 0) {
        const closes = ohlcv.map((candle) => candle.close);
        const ma30Series = sma(closes, 30).map((value, index) =>
          Number.isFinite(value) ? value : closes[index]
        );
        const chart = renderAsciiChartSeries([
          closes.slice(-plotPoints),
          ma30Series.slice(-plotPoints),
        ]);
        printAsciiPlot(outputFormat, `Close + MA30 (last ${plotPoints} points)`, chart);
      }
      const equityPoints = Math.min(gridResult.equityCurve.length, 120);
      if (equityPoints > 0) {
        const chart = renderAsciiChartSeries([gridResult.equityCurve.slice(-equityPoints)]);
        printAsciiPlot(outputFormat, `Equity curve (last ${equityPoints} points)`, chart);
      }
    }
    if (shouldRenderPngPlot(options, outputFormat)) {
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
    outputDefaults.ohlcvSource === 'cache' ||
    outputDefaults.ohlcvSource === 'exchange' ||
    outputDefaults.ohlcvSource === 'auto'
      ? outputDefaults.ohlcvSource
      : 'auto';

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
    const source = await promptChoice(rl, 'Источник OHLCV', ['cache', 'exchange', 'auto'] as const, defaultSource);
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
  .option('--rebuild-cache', 'Rebuild cache', false)
  .option('--rebuild', 'Rebuild cache (deprecated)', false)
  .option('--fill-gaps', 'Fill missing OHLCV gaps', false)
  .option('--no-rate-limit', 'Disable CCXT rate limiting')
  .option('--verbose', 'Enable verbose OHLCV logging')
  .option('--quiet', 'Suppress OHLCV logs')
  .addHelpText(
    'after',
    `
Examples:
  $ npm start -- data:fetch-ohlcv --exchange gate --symbol RAVE/USDT --timeframe 1m --since 2024-01-01
  $ npm start -- data:fetch-ohlcv --symbol BTC/USDT --timeframe 1h --since 2024-06-01 --limit 500 --rebuild-cache
`
  )
  .action(async (options) => {
    try {
      const limit = parseInt(options.limit, 10);
      const rebuildCache = Boolean(options.rebuildCache || options.rebuild);
      const data = await resolveOhlcv({
        exchange: options.exchange,
        symbol: options.symbol,
        timeframe: options.timeframe,
        since: options.since,
        until: options.until,
        limit,
        source: 'exchange',
        rebuildCache,
        fillGaps: Boolean(options.fillGaps),
        rateLimit: resolveRateLimit(options),
        ...resolveOhlcvLogOptions(options),
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
  .option('--ohlcv-source <source>', 'OHLCV source: exchange|cache|auto', 'auto')
  .option('--rebuild-cache', 'Rebuild cache', false)
  .option('--fill-gaps', 'Fill missing OHLCV gaps', false)
  .option('--no-rate-limit', 'Disable CCXT rate limiting')
  .option('--verbose', 'Enable verbose OHLCV logging')
  .option('--quiet', 'Suppress OHLCV logs')
  .option('--plot <type>', 'Plot type: ascii')
  .option('--output <format>', 'Output format: text|json|md', 'text')
  .option('--save-report', 'Save report to file')
  .addHelpText(
    'after',
    `
Examples:
  $ npm start -- analysis:analyze-regime --exchange gate --symbol RAVE/USDT --since 2024-01-01
  $ npm start -- analysis:analyze-regime --symbol BTC/USDT --since 2023-10-01 --plot ascii
  $ npm start -- analysis:analyze-regime --symbol BTC/USDT --since 2023-10-01 --output md --save-report
`
  )
  .action(async (options) => {
    const outputFormat = readOutputFormat(options);
    const limit = parseInt(options.limit, 10);
    const ohlcv = await resolveOhlcv({
      exchange: options.exchange,
      symbol: options.symbol,
      timeframe: '15m',
      since: options.since,
      until: options.until,
      limit,
      source: options.ohlcvSource,
      rebuildCache: Boolean(options.rebuildCache),
      fillGaps: Boolean(options.fillGaps),
      rateLimit: resolveRateLimit(options),
      ...resolveOhlcvLogOptions(options),
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
  .option('--ohlcv-source <source>', 'OHLCV source: exchange|cache|auto', 'auto')
  .option('--rebuild-cache', 'Rebuild cache', false)
  .option('--fill-gaps', 'Fill missing OHLCV gaps', false)
  .option('--no-rate-limit', 'Disable CCXT rate limiting')
  .option('--verbose', 'Enable verbose OHLCV logging')
  .option('--quiet', 'Suppress OHLCV logs')
  .option('--output <format>', 'Output format: text|json|md', 'text')
  .option('--save-report', 'Save report to file')
  .option('--no-llm', 'Disable LLM analysis output')
  .option('--no-cache', 'Bypass OHLCV cache for fresh pulls')
  .action(async (options) => {
    const outputFormat = readOutputFormat(options);

    try {
      const exchange = createCcxtExchange(options.exchange, options);
      let since: string | undefined;
      let until: string | undefined;
      if (options.since) {
        since = options.since;
        until = new Date().toISOString();
      } else if (options.months) {
        const months = parseInt(options.months);
        const date = new Date();
        date.setMonth(date.getMonth() - months);
        since = date.toISOString();
        until = new Date().toISOString();
      }

      const limit = parseInt(options.limit, 10);
      const ohlcvSource = options.noCache ? 'exchange' : options.ohlcvSource;
      const candlesRaw = await resolveOhlcv({
        exchange,
        symbol: options.symbol,
        timeframe: options.timeframe,
        since,
        until,
        limit,
        source: ohlcvSource,
        rebuildCache: Boolean(options.rebuildCache || options.noCache),
        fillGaps: Boolean(options.fillGaps),
        ...resolveOhlcvLogOptions(options),
      });
      const candles = candlesRaw.map((candle) => ({
        ...candle,
        timeframe: options.timeframe,
        symbol: options.symbol,
      }));
      const currentPrice = candles[candles.length - 1].close;

      let fundingRate: number | undefined;
      if (options.timeframe.endsWith('m') || options.timeframe.endsWith('h')) {
        const funding = await fetchFundingRate(exchange, options.symbol).catch(() => null);
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

      const indicatorRows: Record<string, ReportValue> = {
        rsi: indicators.rsi ? indicators.rsi.toFixed(2) : null,
        macd: indicators.macd ? indicators.macd.macd.toFixed(4) : null,
        ema_fast: indicators.emaFast ? indicators.emaFast.toFixed(2) : null,
        ema_slow: indicators.emaSlow ? indicators.emaSlow.toFixed(2) : null,
        obv: typeof indicators.obv === 'number' ? indicators.obv.toFixed(2) : null,
        vwap: typeof indicators.vwap === 'number' ? indicators.vwap.toFixed(4) : null,
        funding_rate: typeof indicators.fundingRate === 'number' ? indicators.fundingRate : null,
      };
      const report: ReportPayload = {
        title: 'Pair analysis report',
        sections: [
          {
            title: 'Summary',
            rows: {
              symbol: options.symbol,
              exchange: options.exchange,
              timeframe: options.timeframe,
              current_price: currentPrice.toFixed(2),
              action: combinedSignal.action.toUpperCase(),
              score_buy: combinedSignal.scoreBuy.toFixed(2),
              score_sell: combinedSignal.scoreSell.toFixed(2),
              score_hold: combinedSignal.scoreHold.toFixed(2),
              reasons: combinedSignal.reasons.join('; '),
            },
          },
          {
            title: 'Indicators',
            rows: indicatorRows,
          },
        ],
      };

      let llmSummary: { summary: string; risks: string[]; disclaimer?: string } | null = null;
      if (!options.noLlm && (process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY)) {
        const llmClient = new OpenAILlmClient();
        llmSummary = await llmClient.analyze(
          {
            symbol: options.symbol,
            timeframe: options.timeframe,
            candles,
            indicators,
            strategySignal: combinedSignal,
          },
          'pair'
        );
      }

      if (llmSummary) {
        report.sections.push({
          title: 'LLM analysis',
          rows: {
            summary: llmSummary.summary,
            risks: llmSummary.risks.join('; '),
            disclaimer: llmSummary.disclaimer ?? null,
          },
        });
      }

      renderReportWithSave('analysis:analyze-pair', outputFormat, report, options, options.symbol);
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
  .option('--output <format>', 'Output format: text|json|md', 'text')
  .option('--save-report', 'Save report to file')
  .option('--no-llm', 'Disable LLM analysis')
  .option('--no-rate-limit', 'Disable CCXT rate limiting')
  .action(async (options) => {
    const outputFormat = readOutputFormat(options);

    try {
      const clients = [];
      const enableRateLimit = resolveRateLimit(options);
      if (process.env.KUCOIN_API_KEY) clients.push(new KucoinClient(undefined, undefined, undefined, { enableRateLimit }));
      if (process.env.GATE_API_KEY) clients.push(new GateClient(undefined, undefined, { enableRateLimit }));

      if (clients.length === 0) {
        console.log('No exchange API keys configured. Please set KUCOIN_API_KEY or GATE_API_KEY in .env');
        return;
      }

      const portfolio = await analyzePortfolio(clients);

      const topAssets = portfolio.assets.slice(0, 5).map((asset) => {
        const value = asset.valueUsd === undefined ? 'n/a' : asset.valueUsd.toFixed(2);
        return `${asset.symbol}: $${value} (${asset.exchange})`;
      });
      const report: ReportPayload = {
        title: 'Portfolio analysis report',
        sections: [
          {
            title: 'Summary',
            rows: {
              total_value_usd: portfolio.totalValueUsd.toFixed(2),
              stablecoins_percent: portfolio.concentration.stablecoinsPercent.toFixed(1),
              high_risk_percent: portfolio.concentration.highRiskPercent.toFixed(1),
              top_assets: topAssets.join('; '),
            },
          },
        ],
      };

      let llmSummary: { summary: string; risks: string[] } | null = null;
      if (!options.noLlm && (process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY)) {
        const llm = new OpenAILlmClient();
        llmSummary = await llm.analyze(
          {
            portfolioSummary: portfolio,
          },
          'portfolio'
        );
      }
      if (llmSummary) {
        report.sections.push({
          title: 'LLM analysis',
          rows: {
            summary: llmSummary.summary,
            risks: llmSummary.risks.join('; '),
          },
        });
      }

      renderReportWithSave('analysis:analyze-portfolio', outputFormat, report, options, 'portfolio');
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
  .option('--output <format>', 'Output format: text|json|md', 'text')
  .option('--save-report', 'Save report to file')
  .action(async (options) => {
    const outputFormat = readOutputFormat(options);

    try {
      const news = await aggregateNews(options.symbol);

      const items = news.map((item) => {
        const link = item.rawLink ?? 'n/a';
        return `${item.title} (sentiment: ${item.sentiment}, source: ${item.source}, link: ${link})`;
      });
      const report: ReportPayload = {
        title: 'News analysis report',
        sections: [
          {
            title: 'Summary',
            rows: {
              symbol: options.symbol ?? 'all',
              items: news.length,
            },
          },
          {
            title: 'Items',
            rows: {
              list: items.join('\n'),
            },
          },
        ],
      };

      let llmSummary: { summary: string; scenarios: string[] } | null = null;
      if (process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY) {
        const llm = new OpenAILlmClient();
        llmSummary = await llm.analyze(
          {
            news,
            symbol: options.symbol,
          } as any,
          'news'
        );
      }
      if (llmSummary) {
        report.sections.push({
          title: 'LLM analysis',
          rows: {
            summary: llmSummary.summary,
            scenarios: llmSummary.scenarios.join('; '),
          },
        });
      }

      renderReportWithSave('analysis:analyze-news', outputFormat, report, options, options.symbol ?? 'all');
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
  .option('--output <format>', 'Output format: text|json|md', 'text')
  .option('--save-report', 'Save report to file')
  .option('--no-llm', 'Disable LLM post-run analysis')
  .action(async (options) => {
    const outputFormat = readOutputFormat(options);

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
    renderReportWithSave(
      'trade-sim',
      outputFormat,
      buildSimulationReportPayload(options.symbol, options.timeframe, report),
      options,
      options.symbol
    );

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
  .option('--ohlcv-source <source>', 'OHLCV source: exchange|cache|auto', 'auto')
  .option('--rebuild-cache', 'Rebuild cache', false)
  .option('--fill-gaps', 'Fill missing OHLCV gaps', false)
  .option('--no-rate-limit', 'Disable CCXT rate limiting')
  .option('--verbose', 'Enable verbose OHLCV logging')
  .option('--quiet', 'Suppress OHLCV logs')
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
  .option('--ohlcv-source <source>', 'OHLCV source: exchange|cache|auto', 'auto')
  .option('--rebuild-cache', 'Rebuild cache', false)
  .option('--fill-gaps', 'Fill missing OHLCV gaps', false)
  .option('--no-rate-limit', 'Disable CCXT rate limiting')
  .option('--verbose', 'Enable verbose OHLCV logging')
  .option('--quiet', 'Suppress OHLCV logs')
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
  .option('--ohlcv-source <source>', 'OHLCV source: exchange|cache|auto', 'auto')
  .option('--rebuild-cache', 'Rebuild cache', false)
  .option('--fill-gaps', 'Fill missing OHLCV gaps', false)
  .option('--no-rate-limit', 'Disable CCXT rate limiting')
  .option('--verbose', 'Enable verbose OHLCV logging')
  .option('--quiet', 'Suppress OHLCV logs')
  .option('--mode <mode>', 'Backtest mode: spot|trailing', 'spot')
  .option('--low <low>', 'Grid low price (number|auto)')
  .option('--high <high>', 'Grid high price (number|auto)')
  .option('--grid-low <low>', 'Grid low price (deprecated)')
  .option('--grid-high <high>', 'Grid high price (deprecated)')
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
  .option('--ma-timeframe <timeframe>', 'MA30 stop timeframe: 15m|native', '15m')
  .option('--stop-on-ma30 <enabled>', 'Stop when close drops below MA30 (true|false)')
  .option('--stop-on-low-closes <count>', 'Stop after N closes below grid low')
  .option('--plot <type>', 'Plot type: ascii|png (png saved to reports/)')
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
  .option('--config <path>', 'Config path')
  .option('--exchange <exchange>', 'Exchange ID', 'gate')
  .option('--symbol <symbol>', 'Symbol', 'RAVE/USDT')
  .option('--timeframe <timeframe>', 'Timeframe', '1m')
  .option('--since <since>', 'Start date (ISO)')
  .option('--until <until>', 'End date (ISO)')
  .option('--low <low>', 'Grid low price (number|auto)')
  .option('--high <high>', 'Grid high price (number|auto)')
  .option('--grid-low <low>', 'Grid low price (deprecated)')
  .option('--grid-high <high>', 'Grid high price (deprecated)')
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
  .option('--ohlcv-source <source>', 'OHLCV source: exchange|cache|auto', 'auto')
  .option('--rebuild-cache', 'Rebuild cache', false)
  .option('--fill-gaps', 'Fill missing OHLCV gaps', false)
  .option('--no-rate-limit', 'Disable CCXT rate limiting')
  .option('--verbose', 'Enable verbose OHLCV logging')
  .option('--quiet', 'Suppress OHLCV logs')
  .option('--ohlcv-limit <limit>', 'Max candles', '10000')
  .option('--ledger-fee-mode <mode>', 'Ledger fee mode: separate|ohlcv', 'separate')
  .option('--plot <type>', 'Plot type: png (saved to reports/)')
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
      const { config, configPath, configExists, configSource } = resolveConfigInfo(options);
      const outputDefaults = config.output ?? {};
      const feeDefaults = config.fees ?? {};
      const defaultSymbol = config.symbols?.[0] ?? 'RAVE/USDT';
      const exchange = resolveConfigString(options, 'exchange', ['--exchange'], config.exchange, 'gate');
      const symbol = resolveConfigString(options, 'symbol', ['--symbol'], defaultSymbol, 'RAVE/USDT');
      const timeframe = resolveConfigString(options, 'timeframe', ['--timeframe'], outputDefaults.timeframe, '1m');
      const ohlcvSource = resolveConfigString(
        options,
        'ohlcvSource',
        ['--ohlcv-source'],
        outputDefaults.ohlcvSource,
        'auto'
      );
      const ohlcvLimit = resolveConfigNumber(options, 'ohlcvLimit', ['--ohlcv-limit'], outputDefaults.limit, 10000);
      const { name: profileName, defaults: profileDefaults } = getProfileDefaults(readStringOption(options, 'profile'));
      const ledgerPath = readStringOption(options, 'ledger');
      if (!ledgerPath) {
        throw new Error('Ledger path is required. Use --ledger <file>.');
      }
      const entries = importLedger(ledgerPath);
      const feeMode = readLedgerFeeMode(options);
      const resolvedCompareOptions: Record<string, unknown> = {
        ...options,
        exchange,
        symbol,
        timeframe,
        ohlcvSource,
        ohlcvLimit: String(ohlcvLimit),
        rebuildCache: readBooleanOption(options, 'rebuildCache'),
        fillGaps: readBooleanOption(options, 'fillGaps'),
      };
      const gtFeeResolution =
        feeMode === 'ohlcv'
          ? await resolveGtFeeQuoteResolver(entries, resolvedCompareOptions)
          : { resolver: undefined, ohlcvCount: 0 };
      const gtFeeQuoteResolver = gtFeeResolution.resolver;
      const summary = analyzeLedger(entries, { feeMode, gtFeeQuoteResolver });
      if (!summary.startTime || !summary.endTime) {
        renderReportWithSave(
          'compare',
          outputFormat,
          {
            title: 'Status',
            sections: [
              {
                title: 'Config',
                rows: buildConfigSummaryRows({ configPath, configExists, configSource }),
              },
              {
                title: 'Profile',
                rows: buildProfileSummaryRows({ profile: profileName }),
              },
              {
                title: 'Message',
                rows: { message: 'Not enough trade data to build a report.' },
              },
            ],
          },
          options,
          symbol
        );
        return;
      }

      const { metrics: ledgerMetrics, feesBreakdown } = buildLedgerMetrics(summary);

      const sinceOption = resolveConfigOptionalString(options, 'since', ['--since'], outputDefaults.since);
      const untilOption = resolveConfigOptionalString(options, 'until', ['--until'], outputDefaults.until);
      const backtestSince = sinceOption ?? summary.startTime.toISOString();
      const backtestUntil = untilOption ?? summary.endTime.toISOString();
      const ohlcv = await resolveOhlcv({
        exchange,
        symbol,
        timeframe,
        since: backtestSince,
        until: backtestUntil,
        source: ohlcvSource as OhlcvSource,
        limit: ohlcvLimit,
        rebuildCache: readBooleanOption(options, 'rebuildCache'),
        fillGaps: readBooleanOption(options, 'fillGaps'),
        rateLimit: resolveRateLimit(options),
        ...resolveOhlcvLogOptions(options),
      });
      if (!ohlcv.length) {
        renderReportWithSave(
          'compare',
          outputFormat,
          {
            title: 'Status',
            sections: [
              {
                title: 'Config',
                rows: buildConfigSummaryRows({ configPath, configExists, configSource }),
              },
              {
                title: 'Profile',
                rows: buildProfileSummaryRows({ profile: profileName }),
              },
              {
                title: 'Message',
                rows: { message: 'No OHLCV data available for the requested period.' },
              },
            ],
          },
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
          {
            title: 'Status',
            sections: [
              {
                title: 'Config',
                rows: buildConfigSummaryRows({ configPath, configExists, configSource }),
              },
              {
                title: 'Profile',
                rows: buildProfileSummaryRows({ profile: profileName }),
              },
              {
                title: 'Message',
                rows: { message: 'No OHLCV data available for the requested period.' },
              },
            ],
          },
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
      const feeInputs = resolveFeeInputs(options, feeDefaults, profileDefaults, slippageRate);
      const feeOptions = buildFeeOptions(feeModel, feeInputs);
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
            title: 'Config',
            rows: buildConfigSummaryRows({ configPath, configExists, configSource }),
          },
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
              ohlcv_source: ohlcvSource,
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
            title: 'Parameters',
            rows: buildBacktestParamRows({
              grids,
              low,
              high,
              allocation,
              trailStepPercent: profileDefaults.trailStepPercent,
              stopOnMa30: profileDefaults.stopOnMa30,
              stopOnLowCloses: profileDefaults.stopOnLowCloses,
            }),
          },
          {
            title: 'Fees',
            rows: buildFeeSummaryRows(feeModel, feeInputs),
          },
          {
            title: 'Grid backtest metrics',
            rows: buildGridMetricsRows(gridResult),
          },
          {
            title: 'PnL delta',
            rows: {
              ledger_net_minus_grid_net: (ledgerMetrics.pnlNet - gridResult.pnlNet).toFixed(4),
            },
          },
        ],
      };
      if (shouldRenderPngPlot(options, outputFormat)) {
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
