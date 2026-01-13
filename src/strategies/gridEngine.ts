import { OHLCV } from '../real/ohlcv';

export interface GridResult {
  pnlGross: number;
  pnlNet: number;
  maxDD: number;
  tradesCount: number;
  turnover: number;
  feesTotal: number;
  feeRatio: number;
}

export interface GridEngineOptions {
  ohlcv: OHLCV[];
  low: number;
  high: number;
  grids: number;
  allocation: number;
  feeRate?: number;
  makerFeeRate?: number;
  takerFeeRate?: number;
  slippageRate?: number;
  trailStepPercent?: number;
  stopOnMa30?: boolean;
  stopOnLowCloses?: number;
}

interface GridState {
  low: number;
  high: number;
  step: number;
  levels: number[];
}

function buildGridState(low: number, high: number, grids: number): GridState {
  const levels =
    grids <= 1
      ? [low]
      : Array.from({ length: grids }, (_, i) => low + ((high - low) * i) / (grids - 1));
  return {
    low,
    high,
    step: grids > 1 ? (high - low) / (grids - 1) : 0,
    levels,
  };
}

function shiftRange(state: GridState, grids: number, direction: 'up' | 'down', trailStep: number): GridState {
  const multiplier = direction === 'up' ? 1 + trailStep : 1 - trailStep;
  const low = state.low * multiplier;
  const high = state.high * multiplier;
  return buildGridState(low, high, grids);
}

function resolveExecutionPrice(
  level: number,
  side: 'buy' | 'sell',
  isTaker: boolean,
  slippageRate: number
): number {
  if (!isTaker || slippageRate <= 0) {
    return level;
  }

  return side === 'buy' ? level * (1 + slippageRate) : level * (1 - slippageRate);
}

export function runGridBacktest(options: GridEngineOptions): GridResult {
  const { ohlcv, grids, allocation } = options;

  if (ohlcv.length === 0 || grids <= 0) {
    return {
      pnlGross: 0,
      pnlNet: 0,
      maxDD: 0,
      tradesCount: 0,
      turnover: 0,
      feesTotal: 0,
      feeRatio: 0,
    };
  }

  const makerFeeRate = options.makerFeeRate ?? options.feeRate ?? 0.001;
  const takerFeeRate = options.takerFeeRate ?? options.feeRate ?? 0.002;
  const slippageRate = options.slippageRate ?? 0;
  const trailStepPercent = options.trailStepPercent ?? 0;
  const trailStep = trailStepPercent / 100;
  let state = buildGridState(options.low, options.high, grids);

  const orderValue = allocation / Math.max(1, grids - 1);

  let pnlGross = 0;
  let pnlNet = 0;
  let maxDD = 0;
  let tradesCount = 0;
  let turnover = 0;
  let feesTotal = 0;

  let baseBalance = 0;
  let quoteBalance = allocation;
  let peak = allocation;

  let maSum = 0;
  const maWindow: number[] = [];
  let belowLowCount = 0;
  let lastPrice = ohlcv[0].close;

  for (const candle of ohlcv) {
    const price = candle.close;
    lastPrice = price;

    if (trailStep > 0 && (price > state.high || price < state.low)) {
      state =
        price > state.high
          ? shiftRange(state, grids, 'up', trailStep)
          : shiftRange(state, grids, 'down', trailStep);
    }

    const buyLevels = state.levels.filter((level) => level < lastPrice && candle.low <= level);
    const sellLevels = state.levels.filter((level) => level > lastPrice && candle.high >= level);

    for (let i = buyLevels.length - 1; i >= 0; i -= 1) {
      const level = buyLevels[i];
      const isTaker = candle.open <= level;
      const executionPrice = resolveExecutionPrice(level, 'buy', isTaker, slippageRate);
      const quoteCost = orderValue;
      if (quoteBalance < quoteCost || executionPrice <= 0) {
        continue;
      }

      const qty = quoteCost / executionPrice;
      quoteBalance -= quoteCost;
      baseBalance += qty;
      turnover += quoteCost;
      const feeRate = isTaker ? takerFeeRate : makerFeeRate;
      const fee = quoteCost * feeRate;
      feesTotal += fee;
      quoteBalance -= fee;
      tradesCount += 1;
    }

    for (const level of sellLevels) {
      const isTaker = candle.open >= level;
      const executionPrice = resolveExecutionPrice(level, 'sell', isTaker, slippageRate);
      if (executionPrice <= 0) {
        continue;
      }
      const qty = orderValue / executionPrice;
      if (baseBalance < qty) {
        continue;
      }

      baseBalance -= qty;
      const proceeds = orderValue;
      quoteBalance += proceeds;
      turnover += proceeds;
      const feeRate = isTaker ? takerFeeRate : makerFeeRate;
      const fee = proceeds * feeRate;
      feesTotal += fee;
      quoteBalance -= fee;
      tradesCount += 1;
    }

    const currentEquity = quoteBalance + baseBalance * price;
    if (currentEquity > peak) peak = currentEquity;
    const dd = peak > 0 ? (peak - currentEquity) / peak : 0;
    if (dd > maxDD) maxDD = dd;

    if (options.stopOnMa30) {
      maWindow.push(price);
      maSum += price;
      if (maWindow.length > 30) {
        maSum -= maWindow.shift() ?? 0;
      }

      if (maWindow.length === 30) {
        const ma30 = maSum / 30;
        if (price < ma30) {
          break;
        }
      }
    }

    if (options.stopOnLowCloses) {
      if (price < state.low) {
        belowLowCount += 1;
      } else {
        belowLowCount = 0;
      }

      if (belowLowCount >= options.stopOnLowCloses) {
        break;
      }
    }
  }

  pnlNet = quoteBalance + baseBalance * lastPrice - allocation;
  pnlGross = pnlNet + feesTotal;

  return {
    pnlGross,
    pnlNet,
    maxDD,
    tradesCount,
    turnover,
    feesTotal,
    feeRatio: turnover > 0 ? feesTotal / turnover : 0,
  };
}
