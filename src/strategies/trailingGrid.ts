import { OHLCV } from '../real/ohlcv';
import {
    applyGridCandle,
    buildGridLevels,
    GridConfig,
    GridResult,
    initializeGridState,
} from './spotGrid';

export interface TrailingGridConfig extends GridConfig {
    trailStep: number;
}

export interface TrailingGridResult extends GridResult {
    stopped: boolean;
    stopReason?: string;
}

function calculateMA(values: number[], length: number): number | null {
    if (values.length < length) return null;
    const slice = values.slice(values.length - length);
    const sum = slice.reduce((acc, val) => acc + val, 0);
    return sum / length;
}

function shiftRange(low: number, high: number, trailStep: number, price: number, direction: 'up' | 'down'): { low: number; high: number } {
    const shift = price * (trailStep / 100) * (direction === 'up' ? 1 : -1);
    return {
        low: low + shift,
        high: high + shift,
    };
}

export function backtestTrailingGrid(
    ohlcv: OHLCV[],
    config: TrailingGridConfig
): TrailingGridResult {
    if (ohlcv.length === 0) {
        return {
            pnlGross: 0,
            pnlNet: 0,
            maxDD: 0,
            tradesCount: 0,
            turnover: 0,
            feesGross: 0,
            feesNet: 0,
            feeRatio: 0,
            finalBase: 0,
            finalQuote: 0,
            stopped: false,
        };
    }

    let currentLow = config.low;
    let currentHigh = config.high;
    let state = initializeGridState(config, ohlcv[0].close);
    let consecutiveBelowLow = 0;
    const closes: number[] = [];
    let stopped = false;
    let stopReason: string | undefined;

    for (const candle of ohlcv) {
        closes.push(candle.close);
        const ma30 = calculateMA(closes, 30);

        if (ma30 !== null && candle.close < ma30) {
            stopped = true;
            stopReason = 'Close below MA30';
            break;
        }

        if (candle.close < currentLow) {
            consecutiveBelowLow += 1;
            if (consecutiveBelowLow >= 2) {
                stopped = true;
                stopReason = 'Two closes below LOW';
                break;
            }
        } else {
            consecutiveBelowLow = 0;
        }

        const updatedRange =
            candle.close > currentHigh
                ? shiftRange(currentLow, currentHigh, config.trailStep, candle.close, 'up')
                : candle.close < currentLow
                    ? shiftRange(currentLow, currentHigh, config.trailStep, candle.close, 'down')
                    : null;

        if (updatedRange) {
            currentLow = updatedRange.low;
            currentHigh = updatedRange.high;
            state.levels = buildGridLevels(currentLow, currentHigh, config.grids);
            state.orders.clear();
            state.levels.forEach(level => {
                if (level < candle.close) {
                    state.orders.set(level, 'buy');
                } else if (level > candle.close) {
                    state.orders.set(level, 'sell');
                }
            });
        }

        applyGridCandle(
            state,
            {
                ...config,
                low: currentLow,
                high: currentHigh,
            },
            candle
        );
    }

    const lastPrice = ohlcv[Math.max(0, ohlcv.length - 1)].close;
    const finalEquity = state.quoteBalance + state.baseBalance * lastPrice;
    const pnlGross = finalEquity - config.allocation + state.feesNet;
    const pnlNet = finalEquity - config.allocation;

    return {
        pnlGross,
        pnlNet,
        maxDD: state.maxDD,
        tradesCount: state.tradesCount,
        turnover: state.turnover,
        feesGross: state.feesGross,
        feesNet: state.feesNet,
        feeRatio: state.turnover > 0 ? state.feesNet / state.turnover : 0,
        finalBase: state.baseBalance,
        finalQuote: state.quoteBalance,
        stopped,
        stopReason,
    };
}
