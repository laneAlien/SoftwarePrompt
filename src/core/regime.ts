export type MarketRegime = 'TREND' | 'RANGE' | 'WEAKNESS';

export interface RegimeResult {
    regime: MarketRegime;
    ma30: number;
    slope: number;
    distance: number;
}

export interface RegimeOptions {
    slopeWindow?: number;
    minSlope?: number;
    minDistance?: number;
}

export type RegimeInput = number[] | Array<{ close: number; timestamp: number }>;

export function detectRegime(input: RegimeInput, options: RegimeOptions = {}): RegimeResult {
    const slopeWindow = Math.max(2, options.slopeWindow ?? 5);
    const minSlope = Math.max(0, options.minSlope ?? 0);
    const minDistance = Math.max(0, options.minDistance ?? 0);
    const prices = input.length > 0 && typeof input[0] !== 'number'
        ? input.map((point) => point.close)
        : (input as number[]);

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
    if (slope > minSlope && distance > minDistance) regime = 'TREND';
    if (slope < -minSlope && distance < -minDistance) regime = 'WEAKNESS';

    return {
        regime,
        ma30: lastMa30,
        slope,
        distance,
    };
}
