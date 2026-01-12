export type MarketRegime = 'TREND' | 'RANGE' | 'WEAKNESS';

export interface RegimeResult {
    regime: MarketRegime;
    ma30: number;
    slope: number;
    distance: number;
}

export function detectRegime(
    prices: number[],
    options: { slopeWindow?: number } = {}
): RegimeResult {
    const slopeWindow = Math.max(2, options.slopeWindow ?? 5);

    if (prices.length < 30) {
        return {
            regime: 'RANGE',
            ma30: prices.length > 0 ? prices[prices.length - 1] : 0,
            slope: 0,
            distance: 0,
        };
    }

    const ma30Series: number[] = [];
    for (let i = 29; i < prices.length; i += 1) {
        const window = prices.slice(i - 29, i + 1);
        const ma30 = window.reduce((a, b) => a + b, 0) / 30;
        ma30Series.push(ma30);
    }

    const lastMa30 = ma30Series[ma30Series.length - 1];
    const slopeStartIndex = Math.max(0, ma30Series.length - slopeWindow);
    const slopeWindowSeries = ma30Series.slice(slopeStartIndex);
    const slope =
        slopeWindowSeries.length > 1
            ? (slopeWindowSeries[slopeWindowSeries.length - 1] - slopeWindowSeries[0]) /
              (slopeWindowSeries.length - 1)
            : 0;
    const currentPrice = prices[prices.length - 1];
    const distance = currentPrice - lastMa30;

    let regime: MarketRegime = 'RANGE';
    if (slope > 0 && currentPrice > lastMa30) regime = 'TREND';
    if (slope < 0 && currentPrice < lastMa30) regime = 'WEAKNESS';

    return {
        regime,
        ma30: lastMa30,
        slope,
        distance,
    };
}
