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
  let currentIndex: number | null = null;

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
      currentIndex = resolveGridIndex(price, state, grids);
    }

    const newIndex = resolveGridIndex(price, state, grids);
    if (currentIndex === null) {
      currentIndex = newIndex;
    } else if (newIndex !== currentIndex) {
      if (newIndex > currentIndex) {
        for (let i = currentIndex + 1; i <= newIndex; i += 1) {
          const qty = orderValue / price;
          if (position >= qty) {
            position -= qty;
            balance += orderValue;
            turnover += orderValue;
            fees += orderValue * feeRate;
            tradesCount += 1;
          }
        }
      } else {
        for (let i = currentIndex - 1; i >= newIndex; i -= 1) {
          if (balance >= orderValue) {
            const qty = orderValue / price;
            position += qty;
            balance -= orderValue;
            turnover += orderValue;
            fees += orderValue * feeRate;
            tradesCount += 1;
          }
        }
      }
      currentIndex = newIndex;
    }

    const currentEquity = balance + position * price;
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
