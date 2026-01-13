import fs from 'fs';
import path from 'path';

export type FeeModel = 'flat' | 'maker-taker';
export type VoucherDiscountType = 'percent' | 'fixed';
export type OhlcvSource = 'exchange' | 'cache';
export type BacktestMode = 'spot' | 'trailing';

export interface FeeDefaults {
  model?: FeeModel;
  feeRate?: number;
  makerFeeRate?: number;
  takerFeeRate?: number;
  gtDiscountRate?: number;
  voucherDiscountType?: VoucherDiscountType;
  voucherDiscountValue?: number;
  minimumFee?: number;
  roundingDecimals?: number;
  slippageRate?: number;
}

export interface OutputDefaults {
  timeframe?: string;
  since?: string;
  until?: string;
  limit?: number;
  ohlcvSource?: OhlcvSource;
  mode?: BacktestMode;
}

export interface AppConfig {
  exchange?: string;
  symbols?: string[];
  fees?: FeeDefaults;
  output?: OutputDefaults;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((entry): entry is string => typeof entry === 'string');
  return filtered.length ? filtered : undefined;
}

function normalizeFeeDefaults(raw: unknown): FeeDefaults | undefined {
  if (!isRecord(raw)) return undefined;
  const voucherDiscountType = toString(raw.voucherDiscountType);
  const normalizedVoucher =
    voucherDiscountType === 'percent' || voucherDiscountType === 'fixed' ? voucherDiscountType : undefined;
  return {
    model: toString(raw.model) as FeeModel | undefined,
    feeRate: toNumber(raw.feeRate),
    makerFeeRate: toNumber(raw.makerFeeRate),
    takerFeeRate: toNumber(raw.takerFeeRate),
    gtDiscountRate: toNumber(raw.gtDiscountRate),
    voucherDiscountType: normalizedVoucher,
    voucherDiscountValue: toNumber(raw.voucherDiscountValue),
    minimumFee: toNumber(raw.minimumFee),
    roundingDecimals: toNumber(raw.roundingDecimals),
    slippageRate: toNumber(raw.slippageRate),
  };
}

function normalizeOutputDefaults(raw: unknown): OutputDefaults | undefined {
  if (!isRecord(raw)) return undefined;
  const ohlcvSource = toString(raw.ohlcvSource);
  const mode = toString(raw.mode);
  return {
    timeframe: toString(raw.timeframe),
    since: toString(raw.since),
    until: toString(raw.until),
    limit: toNumber(raw.limit),
    ohlcvSource: ohlcvSource === 'exchange' || ohlcvSource === 'cache' ? ohlcvSource : undefined,
    mode: mode === 'spot' || mode === 'trailing' ? mode : undefined,
  };
}

function normalizeConfig(raw: unknown): AppConfig {
  if (!isRecord(raw)) return {};
  return {
    exchange: toString(raw.exchange),
    symbols: toStringArray(raw.symbols),
    fees: normalizeFeeDefaults(raw.fees),
    output: normalizeOutputDefaults(raw.output),
  };
}

export function loadConfig(configPath?: string, cwd: string = process.cwd()): AppConfig {
  const resolvedPath = configPath
    ? path.resolve(cwd, configPath)
    : path.resolve(cwd, '.softwarepromptrc.json');
  if (!fs.existsSync(resolvedPath)) {
    if (configPath) {
      throw new Error(`Config file not found: ${resolvedPath}`);
    }
    return {};
  }
  const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8')) as unknown;
  return normalizeConfig(raw);
}
