import { Candle } from '../core/types';
import { generateCandles } from '../simulation/candleGenerator';
import { resolveOhlcv } from './resolveOhlcv';

export type CandleSource = 'auto' | 'cache' | 'exchange' | 'sim';

export interface GetCandlesParams {
  exchange?: string;
  symbol: string;
  timeframe: string;
  since?: string | number;
  until?: string | number;
  limit?: number;
  source?: CandleSource;
  rebuildCache?: boolean;
  fillGaps?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  rateLimit?: boolean;
  sim?: { candles?: number; initialPrice?: number; seed?: number };
}

const DEFAULT_SIM_CANDLES = 200;
const DEFAULT_SIM_PRICE = 100;

function resolveLogOptions(params: GetCandlesParams): { verbose: boolean; log: (msg: string) => void } {
  const quiet = params.quiet ?? false;
  const verbose = params.verbose ?? false;
  const log = quiet ? () => {} : console.log;
  return { verbose: !quiet && verbose, log };
}

function createSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function attachCandleMetadata(candles: Candle[], symbol: string, timeframe: string): Candle[] {
  return candles.map((candle) => ({
    ...candle,
    symbol,
    timeframe,
  }));
}

export async function getCandles(params: GetCandlesParams): Promise<Candle[]> {
  const source = params.source ?? 'auto';
  if (source === 'sim') {
    const candlesCount = params.sim?.candles ?? params.limit ?? DEFAULT_SIM_CANDLES;
    const initialPrice = params.sim?.initialPrice ?? DEFAULT_SIM_PRICE;
    const random = params.sim?.seed !== undefined ? createSeededRandom(params.sim.seed) : undefined;
    const candles = generateCandles({
      initialPrice,
      candlesCount,
      timeframe: params.timeframe,
      volatility: 0.02,
      trendStrength: 0.3,
      shockProbability: 0.05,
      random,
    });
    return attachCandleMetadata(candles, params.symbol, params.timeframe);
  }

  if (!params.exchange) {
    throw new Error('Exchange is required when source is not sim.');
  }

  const { verbose, log } = resolveLogOptions(params);
  const candles = await resolveOhlcv({
    exchange: params.exchange,
    symbol: params.symbol,
    timeframe: params.timeframe,
    since: params.since,
    until: params.until,
    limit: params.limit,
    source,
    rebuildCache: params.rebuildCache,
    fillGaps: params.fillGaps,
    rateLimit: params.rateLimit,
    verbose,
    log,
  });
  return attachCandleMetadata(candles, params.symbol, params.timeframe);
}
