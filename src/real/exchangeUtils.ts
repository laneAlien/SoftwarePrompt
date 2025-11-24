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
