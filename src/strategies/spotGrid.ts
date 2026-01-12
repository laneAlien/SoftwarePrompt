export interface GridResult {
    pnl: number;
    maxDD: number;
    tradesCount: number;
    turnover: number;
    fees: number;
    feeRatio: number;
}

export function backtestSpotGrid(
    ohlcv: any[],
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
    const gridLevels = Array.from({ length: grids + 1 }, (_, i) => low + i * step);
    
    let position = 0;
    let balance = allocation;
    let peak = allocation;

    for (const candle of ohlcv) {
        const price = candle.close;
        // Simple simulation: check if price crossed any grid level
        // In a real grid, we'd have buy/sell orders at each level
        // This is a simplified version for demonstration
        
        // Mark-to-market PnL
        const currentEquity = balance + position * price;
        if (currentEquity > peak) peak = currentEquity;
        const dd = (peak - currentEquity) / peak;
        if (dd > maxDD) maxDD = dd;
    }

    pnl = (balance + position * ohlcv[ohlcv.length - 1].close) - allocation;
    
    return {
        pnl,
        maxDD,
        tradesCount,
        turnover,
        fees,
        feeRatio: turnover > 0 ? fees / turnover : 0
    };
}
