export type MarketRegime = 'TREND' | 'RANGE' | 'WEAKNESS';

export interface RegimeMetrics {
    regime: MarketRegime;
    ma30: number;
    slope: number;
    distance: number;
}

function movingAverage(values: number[], length: number): number | null {
    if (values.length < length) return null;
    const slice = values.slice(values.length - length);
    const sum = slice.reduce((acc, val) => acc + val, 0);
    return sum / length;
}

function slopeOver(values: number[], lookback: number): number {
    if (values.length <= lookback) return 0;
    const start = values[values.length - 1 - lookback];
    const end = values[values.length - 1];
    return (end - start) / lookback;
}

export function detectRegime(prices: number[], slopeLookback = 10, slopeThreshold = 0): RegimeMetrics {
    const ma30 = movingAverage(prices, 30);
    if (ma30 === null) {
        return {
            regime: 'RANGE',
            ma30: 0,
            slope: 0,
            distance: 0,
        };
    }

    const maSeries: number[] = [];
    for (let i = 30; i <= prices.length; i += 1) {
        const ma = movingAverage(prices.slice(0, i), 30);
        if (ma !== null) maSeries.push(ma);
    }

    const slope = slopeOver(maSeries, slopeLookback);
    const currentPrice = prices[prices.length - 1];
    const distance = currentPrice - ma30;

    let regime: MarketRegime = 'RANGE';
    if (slope > slopeThreshold && currentPrice > ma30) {
        regime = 'TREND';
    } else if (slope < -slopeThreshold && currentPrice < ma30) {
        regime = 'WEAKNESS';
    }

    return {
        regime,
        ma30,
        slope,
        distance,
    };
}
