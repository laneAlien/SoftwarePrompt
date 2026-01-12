export type MarketRegime = 'TREND' | 'RANGE' | 'WEAKNESS';

export function detectRegime(prices: number[]): MarketRegime {
    if (prices.length < 30) return 'RANGE';
    
    const ma30 = prices.slice(-30).reduce((a, b) => a + b, 0) / 30;
    const prevMa30 = prices.slice(-31, -1).reduce((a, b) => a + b, 0) / 30;
    const slope = ma30 - prevMa30;
    const currentPrice = prices[prices.length - 1];

    if (slope > 0 && currentPrice > ma30) return 'TREND';
    if (slope < 0 && currentPrice < ma30) return 'WEAKNESS';
    return 'RANGE';
}
