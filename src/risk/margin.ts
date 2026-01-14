export type PositionSide = 'long' | 'short';

const DEFAULT_MMR = 0.005;
const DEFAULT_FEE_RATE = 0.0006;

interface LiqPriceInput {
  entry: number;
  leverage: number;
  mmr?: number;
  feeRate?: number;
}

interface PositionSizingInput {
  balance: number;
  riskPct: number;
  entry: number;
  stop: number;
  leverageMax: number;
}

interface PositionSizingResult {
  positionSize: number;
  marginUsed: number;
  riskUsd: number;
}

interface BufferInput {
  entry: number;
  liqPrice: number;
  side: PositionSide;
}

interface BufferResult {
  distanceAbs: number;
  distancePct: number;
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a valid number.`);
  }
}

function assertPositive(value: number, label: string): void {
  assertFinite(value, label);
  if (value <= 0) {
    throw new Error(`${label} must be greater than 0.`);
  }
}

function assertNonNegative(value: number, label: string): void {
  assertFinite(value, label);
  if (value < 0) {
    throw new Error(`${label} must be 0 or greater.`);
  }
}

function resolveMmr(mmr?: number): number {
  return mmr ?? DEFAULT_MMR;
}

function resolveFeeRate(feeRate?: number): number {
  return feeRate ?? DEFAULT_FEE_RATE;
}

function calcIsolatedLiqPriceCore(entry: number, leverage: number, mmr?: number, feeRate?: number): number {
  const resolvedMmr = resolveMmr(mmr);
  const resolvedFee = resolveFeeRate(feeRate);
  assertPositive(entry, 'Entry price');
  assertPositive(leverage, 'Leverage');
  assertNonNegative(resolvedMmr, 'MMR');
  assertNonNegative(resolvedFee, 'Fee rate');

  // Simplified isolated liquidation buffer:
  // available margin buffer = 1/leverage - mmr - feeRate
  // liq price = entry * (1 - buffer) for long, entry * (1 + buffer) for short.
  const buffer = 1 / leverage - resolvedMmr - resolvedFee;
  if (buffer <= 0) {
    throw new Error('Leverage is too high for the provided MMR/fee rate (no liquidation buffer left).');
  }
  return buffer;
}

export function calcIsolatedLiqPriceLong({ entry, leverage, mmr, feeRate }: LiqPriceInput): number {
  const buffer = calcIsolatedLiqPriceCore(entry, leverage, mmr, feeRate);
  return entry * (1 - buffer);
}

export function calcIsolatedLiqPriceShort({ entry, leverage, mmr, feeRate }: LiqPriceInput): number {
  const buffer = calcIsolatedLiqPriceCore(entry, leverage, mmr, feeRate);
  return entry * (1 + buffer);
}

export function positionSizingByRisk({
  balance,
  riskPct,
  entry,
  stop,
  leverageMax,
}: PositionSizingInput): PositionSizingResult {
  assertPositive(balance, 'Balance');
  assertPositive(entry, 'Entry price');
  assertPositive(stop, 'Stop price');
  assertPositive(leverageMax, 'Max leverage');
  assertFinite(riskPct, 'Risk percentage');
  if (riskPct <= 0 || riskPct >= 1) {
    throw new Error('Risk percentage must be between 0 and 1.');
  }

  const riskPerUnit = Math.abs(entry - stop);
  if (riskPerUnit === 0) {
    throw new Error('Stop price must differ from entry price.');
  }

  // Simple risk sizing:
  // riskUsd = balance * riskPct
  // baseQty = riskUsd / |entry - stop|
  // notional = baseQty * entry
  // enforce leverage cap: maxNotional = balance * leverageMax
  const riskUsdTarget = balance * riskPct;
  const baseQtyTarget = riskUsdTarget / riskPerUnit;
  const notionalTarget = baseQtyTarget * entry;
  const maxNotional = balance * leverageMax;
  const positionSize = Math.min(notionalTarget, maxNotional);
  const baseQty = positionSize / entry;
  const riskUsd = baseQty * riskPerUnit;
  const marginUsed = positionSize / leverageMax;

  return { positionSize, marginUsed, riskUsd };
}

export function calcBufferToLiq({ entry, liqPrice, side }: BufferInput): BufferResult {
  assertPositive(entry, 'Entry price');
  assertPositive(liqPrice, 'Liquidation price');
  const normalizedSide = side.toLowerCase();
  if (normalizedSide !== 'long' && normalizedSide !== 'short') {
    throw new Error('Side must be either "long" or "short".');
  }

  const distanceAbs = normalizedSide === 'long' ? entry - liqPrice : liqPrice - entry;
  if (distanceAbs < 0) {
    throw new Error('Liquidation price is on the wrong side of the entry for the given side.');
  }
  return {
    distanceAbs,
    distancePct: distanceAbs / entry,
  };
}

export const riskDefaults = {
  mmr: DEFAULT_MMR,
  feeRate: DEFAULT_FEE_RATE,
};
