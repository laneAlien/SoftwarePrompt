import ccxt from 'ccxt';

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

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries = 3, delayMs = 750, onRetry } = options;
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      const retryable = isRetryableError(error);

      if (!retryable || attempt > retries) {
        throw error;
      }

      onRetry?.(attempt, error);
      await delay(delayMs * attempt);
    }
  }
}

export function createExchangeOptions(overrides?: Partial<ccxt.Exchange>) {
  return {
    timeout: 30000,
    enableRateLimit: false,
    ...overrides,
  } as ccxt.Exchange;
}

const ohlcvCache = new Map<string, any[]>();

export async function fetchFullOHLCV(
  exchange: ccxt.Exchange,
  symbol: string,
  timeframe: string,
  since: number,
  to: number
): Promise<any[]> {
  const cacheKey = `${exchange.id}:${symbol}:${timeframe}:${since}:${to}`;
  if (ohlcvCache.has(cacheKey)) {
    return ohlcvCache.get(cacheKey)!;
  }

  const limit = 1000;
  let fetchSince = since;
  const all: any[] = [];

  while (fetchSince < to) {
    const batch = await withRetry(() => exchange.fetchOHLCV(symbol, timeframe, fetchSince, limit));
    if (!batch.length) break;
    all.push(...batch);
    const lastTimestamp = batch[batch.length - 1][0];
    if (!lastTimestamp || lastTimestamp <= fetchSince) break;
    fetchSince = lastTimestamp + exchange.parseTimeframe(timeframe) * 1000;
    if (lastTimestamp >= to) break;
  }

  ohlcvCache.set(cacheKey, all);
  return all;
}
