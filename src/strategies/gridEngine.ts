import { OHLCV } from '../real/ohlcv';

export interface GridResult {
  pnl: number;
  maxDD: number;
  tradesCount: number;
  turnover: number;
  fees: number;
  feeRatio: number;
}

export interface GridEngineOptions {
  ohlcv: OHLCV[];
  low: number;
  high: number;
  grids: number;
  allocation: number;
  feeRate?: number;
  trailStepPercent?: number;
  stopOnMa30?: boolean;
  stopOnLowCloses?: number;
}

interface GridState {
  low: number;
  high: number;
  step: number;
}

function buildGridState(low: number, high: number, grids: number): GridState {
  return {
    low,
    high,
    step: (high - low) / grids,
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

export function runGridBacktest(options: GridEngineOptions): GridResult {
  const { ohlcv, grids, allocation } = options;

  if (ohlcv.length === 0 || grids <= 0) {
    return {
      pnl: 0,
      maxDD: 0,
      tradesCount: 0,
      turnover: 0,
      fees: 0,
      feeRatio: 0,
    };
  }

  const feeRate = options.feeRate ?? 0.002;
  const trailStepPercent = options.trailStepPercent ?? 0;
  const trailStep = trailStepPercent / 100;
  let state = buildGridState(options.low, options.high, grids);

  const orderValue = allocation / grids;

  let pnl = 0;
  let maxDD = 0;
  let tradesCount = 0;
  let turnover = 0;
  let fees = 0;

  let position = 0;
  let balance = allocation;
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

    if (toIndex > fromIndex) {
      for (let i = fromIndex + 1; i <= toIndex; i += 1) {
        const levelPrice = resolveGridPrice(state, i);
        const qty = orderValue / levelPrice;
        if (position >= qty) {
          position -= qty;
          balance += orderValue;
          turnover += orderValue;
          fees += orderValue * feeRate;
          tradesCount += 1;
        }
      }
    } else if (toIndex < fromIndex) {
      for (let i = fromIndex - 1; i >= toIndex; i -= 1) {
        if (balance >= orderValue) {
          const levelPrice = resolveGridPrice(state, i);
          const qty = orderValue / levelPrice;
          position += qty;
          balance -= orderValue;
          turnover += orderValue;
          fees += orderValue * feeRate;
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

    const currentEquity = balance + position * close;
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

  pnl = balance + position * lastPrice - allocation;

  return {
    pnl,
    maxDD,
    tradesCount,
    turnover,
    fees,
    feeRatio: turnover > 0 ? fees / turnover : 0,
  };
}
