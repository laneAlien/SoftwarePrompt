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

export interface GridConfig {
    low: number;
    high: number;
    grids: number;
    allocation: number;
    feeModel: FeeModelGate;
    slippageModel?: SlippageModel;
    execution?: 'maker' | 'taker';
}

export interface GridState {
    levels: number[];
    orders: Map<number, 'buy' | 'sell'>;
    baseBalance: number;
    quoteBalance: number;
    tradesCount: number;
    turnover: number;
    feesGross: number;
    feesNet: number;
    peakEquity: number;
    maxDD: number;
    orderSizeQuote: number;
}

export function buildGridLevels(low: number, high: number, grids: number): number[] {
    const step = (high - low) / grids;
    return Array.from({ length: grids + 1 }, (_, i) => low + step * i);
}

export function initializeGridState(config: GridConfig, initialPrice: number): GridState {
    const levels = buildGridLevels(config.low, config.high, config.grids);
    const orders = new Map<number, 'buy' | 'sell'>();
    const baseAllocation = config.allocation * 0.5;
    const quoteAllocation = config.allocation - baseAllocation;
    const baseBalance = baseAllocation / initialPrice;
    const quoteBalance = quoteAllocation;
    const orderSizeQuote = config.allocation / config.grids;

    levels.forEach(level => {
        if (level < initialPrice) {
            orders.set(level, 'buy');
        } else if (level > initialPrice) {
            orders.set(level, 'sell');
        }
    });

    return {
        levels,
        orders,
        baseBalance,
        quoteBalance,
        tradesCount: 0,
        turnover: 0,
        feesGross: 0,
        feesNet: 0,
        peakEquity: config.allocation,
        maxDD: 0,
        orderSizeQuote,
    };
}

function executionPrice(level: number, side: 'buy' | 'sell', slippage: SlippageModel, execution: 'maker' | 'taker'): number {
    const rate = execution === 'maker' ? slippage.maker : slippage.taker;
    if (side === 'buy') {
        return level * (1 + rate);
    }
    return level * (1 - rate);
}

function processOrder(
    state: GridState,
    level: number,
    side: 'buy' | 'sell',
    config: GridConfig
): void {
    const slippageModel = config.slippageModel ?? { maker: 0, taker: 0 };
    const execution = config.execution ?? 'maker';
    const price = executionPrice(level, side, slippageModel, execution);
    const isMaker = execution === 'maker';

    if (side === 'buy') {
        const quoteToSpend = state.orderSizeQuote;
        if (state.quoteBalance < quoteToSpend) return;
        const baseQty = quoteToSpend / price;
        const fee = calculateFee(quoteToSpend, isMaker, config.feeModel);
        state.quoteBalance -= quoteToSpend + fee.feeNet;
        state.baseBalance += baseQty;
        state.feesGross += fee.feeGross;
        state.feesNet += fee.feeNet;
        state.turnover += quoteToSpend;
        state.tradesCount += 1;

        const idx = state.levels.indexOf(level);
        const nextLevel = state.levels[idx + 1];
        if (nextLevel !== undefined) {
            state.orders.set(nextLevel, 'sell');
        }
    } else {
        const baseQty = state.orderSizeQuote / price;
        if (state.baseBalance < baseQty) return;
        const notional = baseQty * price;
        const fee = calculateFee(notional, isMaker, config.feeModel);
        state.baseBalance -= baseQty;
        state.quoteBalance += notional - fee.feeNet;
        state.feesGross += fee.feeGross;
        state.feesNet += fee.feeNet;
        state.turnover += notional;
        state.tradesCount += 1;

        const idx = state.levels.indexOf(level);
        const nextLevel = state.levels[idx - 1];
        if (nextLevel !== undefined) {
            state.orders.set(nextLevel, 'buy');
        }
    }

    state.orders.delete(level);
}

function updateDrawdown(state: GridState, price: number): void {
    const equity = state.quoteBalance + state.baseBalance * price;
    if (equity > state.peakEquity) {
        state.peakEquity = equity;
    }
    const dd = (state.peakEquity - equity) / state.peakEquity;
    if (dd > state.maxDD) {
        state.maxDD = dd;
    }
}

function executeLevelsInRange(
    state: GridState,
    config: GridConfig,
    levels: number[],
    side: 'buy' | 'sell'
): void {
    levels.forEach(level => {
        const orderSide = state.orders.get(level);
        if (orderSide === side) {
            processOrder(state, level, side, config);
        }
    });
}

export function applyGridCandle(state: GridState, config: GridConfig, candle: OHLCV): void {
    const touchedLevels = state.levels.filter(level => level >= candle.low && level <= candle.high);
    const ascending = [...touchedLevels].sort((a, b) => a - b);
    const descending = [...ascending].reverse();

    if (candle.close >= candle.open) {
        executeLevelsInRange(state, config, descending, 'buy');
        executeLevelsInRange(state, config, ascending, 'sell');
    } else {
        executeLevelsInRange(state, config, ascending, 'sell');
        executeLevelsInRange(state, config, descending, 'buy');
    }

    updateDrawdown(state, candle.close);
}

export function backtestSpotGrid(ohlcv: OHLCV[], config: GridConfig): GridResult {
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
        };
    }

    const state = initializeGridState(config, ohlcv[0].close);

    for (const candle of ohlcv) {
        applyGridCandle(state, config, candle);
    }

    const lastPrice = ohlcv[ohlcv.length - 1].close;
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
    };
}
