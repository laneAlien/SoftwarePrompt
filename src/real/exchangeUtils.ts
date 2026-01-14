import type { Exchange, OHLCV } from 'ccxt';

export interface RetryOptions {
  retries?: number;
  delayMs?: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const err = error as { name?: string; message?: string };
  const message = `${err.name ?? ''} ${err.message ?? ''}`.toLowerCase();

  const retryKeywords = ['timeout', 'network', 'ddos', 'rate limit', 'connection', 'fetch'];
  return retryKeywords.some((keyword) => message.includes(keyword));
}

export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { name?: string; message?: string };
  const message = `${err.name ?? ''} ${err.message ?? ''}`.toLowerCase();
  return message.includes('rate limit') || message.includes('too many requests') || message.includes('429');
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries = 3, delayMs = 750, onRetry } = options;
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      const retryable = isRetryableError(error);
      const rateLimited = isRateLimitError(error);
      const maxRetries = rateLimited ? Math.min(retries, 1) : retries;

      if (!retryable || attempt > maxRetries) {
        throw error;
      }

      onRetry?.(attempt, error);
      const delayMultiplier = rateLimited ? 2 : 1;
      await delay(delayMs * attempt * delayMultiplier);
    }
  }
}

export function createExchangeOptions(overrides?: Partial<Exchange>) {
  return {
    timeout: 30000,
    enableRateLimit: true,
    ...overrides,
  } as any;
}

const ohlcvCache = new Map<string, any[]>();

export async function fetchFullOHLCV(
  exchange: Exchange,
  symbol: string,
  timeframe: string,
  since: number,
  to: number,
  options: { skipCache?: boolean } = {}
): Promise<any[]> {
  const cacheKey = `${exchange.id}:${symbol}:${timeframe}:${since}:${to}`;
  if (!options.skipCache && ohlcvCache.has(cacheKey)) {
    return ohlcvCache.get(cacheKey)!;
  }

  const limit = 1000;
  let fetchSince = since;
  const all: any[] = [];

  while (fetchSince < to) {
    const batch = (await withRetry(() => exchange.fetchOHLCV(symbol, timeframe, fetchSince, limit))) as OHLCV[];
    if (!batch.length) break;
    all.push(...batch);
    const lastTimestamp = batch[batch.length - 1][0];
    if (!lastTimestamp || lastTimestamp <= fetchSince) break;
    fetchSince = lastTimestamp + exchange.parseTimeframe(timeframe) * 1000;
    if (lastTimestamp >= to) break;
  }

  if (!options.skipCache) {
    ohlcvCache.set(cacheKey, all);
  }
  return all;
}

export function clearOhlcvCache() {
  ohlcvCache.clear();
}
