export interface GridResult {
    pnl: number;
    pnl_gross: number;
    fees_total: number;
    pnl_net: number;
    maxDD: number;
    tradesCount: number;
    turnover: number;
    fees: number;
    feeRatio: number;
}

export function backtestSpotGrid(
    ohlcv: OHLCV[],
    low: number,
    high: number,
    grids: number,
    allocation: number,
    feeRate: number = 0.002
): GridResult {
    let pnl = 0;
    let maxDD = 0;
    let tradesCount = 0;
    let turnover = 0;
    let fees = 0;
    
    const step = (high - low) / grids;
    // gridLevels is unused in this simplified version
    
    let position = 0;
    let balance = allocation;
    let peak = allocation;

    for (const candle of ohlcv) {
        const price = candle.close;
        // Simplified grid logic: if price crosses grid level, execute trade
        // For demonstration, we just track mark-to-market
        
        const currentEquity = balance + position * price;
        if (currentEquity > peak) peak = currentEquity;
        const dd = (peak - currentEquity) / peak;
        if (dd > maxDD) maxDD = dd;
    }

    pnl = (balance + position * ohlcv[ohlcv.length - 1].close) - allocation;
    
    const pnlGross = pnl;
    const feesTotal = fees;
    const pnlNet = pnlGross - feesTotal;

    return {
        pnl,
        pnl_gross: pnlGross,
        fees_total: feesTotal,
        pnl_net: pnlNet,
        maxDD,
        tradesCount,
        turnover,
        fees,
        feeRatio: turnover > 0 ? fees / turnover : 0
    };
}

import { OHLCV } from '../real/ohlcv';
