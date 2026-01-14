import { Candle } from '../core/types';
import { parseTimeframeToMs } from '../core/utils';

export interface SimulationParams {
  initialPrice: number;
  candlesCount: number;
  timeframe: string;
  volatility: number;
  trendStrength: number;
  shockProbability: number;
  random?: () => number;
}

export function generateCandles(params: SimulationParams): Candle[] {
  const {
    initialPrice,
    candlesCount,
    timeframe,
    volatility,
    trendStrength,
    shockProbability,
    random,
  } = params;
  const rand = random ?? Math.random;

  const candles: Candle[] = [];
  const timeframeMs = parseTimeframeToMs(timeframe);
  let currentTime = Date.now() - candlesCount * timeframeMs;
  let price = initialPrice;

  for (let i = 0; i < candlesCount; i++) {
    const trendComponent = (rand() - 0.5) * 2 * trendStrength * volatility * price;
    const noise = (rand() - 0.5) * 2 * volatility * price;
    
    let priceChange = trendComponent + noise;

    if (rand() < shockProbability) {
      const shockDirection = rand() > 0.5 ? 1 : -1;
      const shockMagnitude = (rand() * 3 + 2) * volatility * price;
      priceChange += shockDirection * shockMagnitude;
    }

    price = Math.max(price + priceChange, price * 0.5);

    const candleVolatility = volatility * price * 0.5;
    const open = price;
    const close = Math.max(price + (rand() - 0.5) * candleVolatility, price * 0.5);
    const high = Math.max(open, close) + rand() * candleVolatility;
    const low = Math.min(open, close) - rand() * candleVolatility;
    const volume = rand() * 10000 + 1000;

    candles.push({
      timestamp: currentTime,
      open,
      high,
      low,
      close,
      volume,
      timeframe,
    });

    price = close;
    currentTime += timeframeMs;
  }

  return candles;
}
