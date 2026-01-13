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

function resolveGridIndex(price: number, state: GridState, grids: number): number {
  if (price <= state.low) return 0;
  if (price >= state.high) return grids;
  return Math.floor((price - state.low) / state.step);
}

function resolveGridPrice(state: GridState, index: number): number {
  return state.low + state.step * index;
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
  let lastPrice = ohlcv[0].open;
  let currentIndex: number | null = resolveGridIndex(lastPrice, state, grids);

  const executeMove = (fromPrice: number, toPrice: number): void => {
    if (fromPrice === toPrice) {
      currentIndex = resolveGridIndex(toPrice, state, grids);
      return;
    }

    const fromIndex = currentIndex ?? resolveGridIndex(fromPrice, state, grids);
    const toIndex = resolveGridIndex(toPrice, state, grids);

    const isTaker = slippageRate > 0;
    const feeRate = isTaker ? takerFeeRate : makerFeeRate;

    if (toIndex > fromIndex) {
      for (let i = fromIndex + 1; i <= toIndex; i += 1) {
        const levelPrice = resolveGridPrice(state, i);
        const executionPrice = resolveExecutionPrice(levelPrice, 'sell', isTaker, slippageRate);
        const qty = orderValue / levelPrice;
        if (baseBalance >= qty) {
          const tradeValue = qty * executionPrice;
          const fee = tradeValue * feeRate;
          baseBalance -= qty;
          quoteBalance += tradeValue;
          quoteBalance -= fee;
          turnover += tradeValue;
          feesTotal += fee;
          tradesCount += 1;
        }
      }
    } else if (toIndex < fromIndex) {
      for (let i = fromIndex - 1; i >= toIndex; i -= 1) {
        const levelPrice = resolveGridPrice(state, i);
        const executionPrice = resolveExecutionPrice(levelPrice, 'buy', isTaker, slippageRate);
        const qty = orderValue / levelPrice;
        const tradeValue = qty * executionPrice;
        const fee = tradeValue * feeRate;
        if (quoteBalance >= tradeValue + fee) {
          baseBalance += qty;
          quoteBalance -= tradeValue;
          quoteBalance -= fee;
          turnover += tradeValue;
          feesTotal += fee;
          tradesCount += 1;
        }
      }
    }

    currentIndex = toIndex;
  };

  for (const candle of ohlcv) {
    const { open, high, low, close } = candle;
    lastPrice = close;

    if (trailStep > 0 && (high > state.high || low < state.low)) {
      const shouldShiftUp =
        high > state.high && (close >= state.high || low >= state.low || close >= open);
      const direction = shouldShiftUp ? 'up' : 'down';
      state = shiftRange(state, grids, direction, trailStep);
      currentIndex = resolveGridIndex(open, state, grids);
    }

    const moves: Array<[number, number]> = [];
    if (close >= open) {
      moves.push([open, low], [low, high], [high, close]);
    } else {
      moves.push([open, high], [high, low], [low, close]);
    }

    for (const [fromPrice, toPrice] of moves) {
      executeMove(fromPrice, toPrice);
    }

    const currentEquity = quoteBalance + baseBalance * close;
    if (currentEquity > peak) peak = currentEquity;
    const dd = peak > 0 ? (peak - currentEquity) / peak : 0;
    if (dd > maxDD) maxDD = dd;

    if (options.stopOnMa30) {
      maWindow.push(close);
      maSum += close;
      if (maWindow.length > 30) {
        maSum -= maWindow.shift() ?? 0;
      }

      if (maWindow.length === 30) {
        const ma30 = maSum / 30;
        if (close < ma30) {
          break;
        }
      }
    }

    if (options.stopOnLowCloses) {
      if (close < state.low) {
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
