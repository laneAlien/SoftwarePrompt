import { OHLCV } from '../real/ohlcv';
import { calculateFee, FeeModelGate } from '../core/feeModelGate';

export interface SlippageModel {
    maker: number;
    taker: number;
}

export interface GridResult {
    pnlGross: number;
    pnlNet: number;
    maxDD: number;
    tradesCount: number;
    turnover: number;
    feesGross: number;
    feesNet: number;
    feeRatio: number;
    finalBase: number;
    finalQuote: number;
}

export function backtestSpotGrid(
    ohlcv: OHLCV[],
    low: number,
    high: number,
    grids: number,
    allocation: number,
    feeRate: number = 0.002,
    slippageRate: number = 0.0005,
    takerFeeRate: number = feeRate * 1.5
): GridResult {
    let maxDD = 0;
    let tradesCount = 0;
    let turnover = 0;
    let fees = 0;

    const step = (high - low) / grids;
    const gridLevels = Array.from({ length: grids + 1 }, (_, idx) => low + step * idx);
    const intervalQtys = Array.from({ length: grids }, () => 0);

    const makerFeeRate = feeRate;
    let position = 0;
    let balance = allocation;
    let peak = allocation;
    let prevClose: number | null = null;

    const recordTrade = (qty: number, price: number, feeRateToUse: number, side: 'buy' | 'sell') => {
        const notional = qty * price;
        const fee = notional * feeRateToUse;
        if (side === 'buy') {
            const totalCost = notional + fee;
            if (balance < totalCost) return false;
            balance -= totalCost;
            position += qty;
        } else {
            balance += notional - fee;
            position -= qty;
        }
        turnover += notional;
        fees += fee;
        tradesCount += 1;
        return true;
    };

    const executeBuy = (levelIndex: number, executionPrice: number, feeRateToUse: number) => {
        if (levelIndex < 0 || levelIndex >= intervalQtys.length) return;
        if (intervalQtys[levelIndex] > 0) return;
        const quotePerGrid = allocation / grids;
        const qty = quotePerGrid / executionPrice;
        if (recordTrade(qty, executionPrice, feeRateToUse, 'buy')) {
            intervalQtys[levelIndex] = qty;
        }
    };

    const executeSell = (levelIndex: number, executionPrice: number, feeRateToUse: number) => {
        if (levelIndex < 0 || levelIndex >= intervalQtys.length) return;
        const qty = intervalQtys[levelIndex];
        if (qty <= 0) return;
        recordTrade(qty, executionPrice, feeRateToUse, 'sell');
        intervalQtys[levelIndex] = 0;
    };

    const processGap = (open: number) => {
        if (prevClose === null) return;
        if (open === prevClose) return;
        if (open < prevClose) {
            const upper = prevClose;
            const lower = open;
            for (let i = gridLevels.length - 1; i >= 0; i -= 1) {
                const level = gridLevels[i];
                if (level < lower || level > upper) continue;
                const executionPrice = open * (1 + slippageRate);
                executeBuy(i, executionPrice, takerFeeRate);
            }
        } else {
            const upper = open;
            const lower = prevClose;
            for (let i = 0; i < gridLevels.length; i += 1) {
                const level = gridLevels[i];
                if (level < lower || level > upper) continue;
                const executionPrice = open * (1 - slippageRate);
                executeSell(i - 1, executionPrice, takerFeeRate);
            }
        }
    };

    const processSegment = (start: number, end: number, direction: 'up' | 'down') => {
        if (start === end) return;
        const min = Math.min(start, end);
        const max = Math.max(start, end);
        if (direction === 'down') {
            for (let i = gridLevels.length - 1; i >= 0; i -= 1) {
                const level = gridLevels[i];
                if (level < min || level > max) continue;
                executeBuy(i, level, makerFeeRate);
            }
            return;
        }
        for (let i = 0; i < gridLevels.length; i += 1) {
            const level = gridLevels[i];
            if (level < min || level > max) continue;
            executeSell(i - 1, level, makerFeeRate);
        }
    };

    for (const candle of ohlcv) {
        processGap(candle.open);

        if (candle.close >= candle.open) {
            processSegment(candle.open, candle.low, 'down');
            processSegment(candle.low, candle.high, 'up');
        } else {
            processSegment(candle.open, candle.high, 'up');
            processSegment(candle.high, candle.low, 'down');
        }

        const currentEquity = balance + position * candle.close;
        if (currentEquity > peak) peak = currentEquity;
        const dd = peak > 0 ? (peak - currentEquity) / peak : 0;
        if (dd > maxDD) maxDD = dd;
        prevClose = candle.close;
    }

    const lastPrice = ohlcv[ohlcv.length - 1]?.close ?? 0;
    const finalEquity = balance + position * lastPrice;
    const pnlNet = finalEquity - allocation;
    const pnlGross = pnlNet + fees;

    return {
        pnlGross,
        pnlNet,
        maxDD,
        tradesCount,
        turnover,
        fees,
        feeRatio: turnover > 0 ? fees / turnover : 0
    };
}
