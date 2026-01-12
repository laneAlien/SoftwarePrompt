import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function fetchOHLCV(
  exchangeId: string,
  symbol: string,
  timeframe: string,
  since: string,
  limit: number = 1000
): Promise<OHLCV[]> {
  const exchange = new (ccxt as any)[exchangeId]({
    enableRateLimit: true,
  });

  const sinceTimestamp = exchange.parse8601(since);
  const cachePath = path.join('data', 'ohlcv', exchangeId, symbol.replace('/', '_'), `${timeframe}.jsonl`);
  
  // Ensure cache directory exists
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });

  let cachedData: OHLCV[] = [];
  if (fs.existsSync(cachePath)) {
    const lines = fs.readFileSync(cachePath, 'utf-8').split('\n').filter(Boolean);
    cachedData = lines.map(line => JSON.parse(line));
  }

  // Find the last cached timestamp
  const lastTimestamp = cachedData.length > 0
    ? Math.max(...cachedData.map(item => item.timestamp))
    : sinceTimestamp;
  
  if (lastTimestamp >= Date.now() - 60000) {
      return cachedData;
  }

  console.log(`Fetching ${symbol} from ${exchangeId}...`);
  const startTimestamp = Math.max(lastTimestamp, sinceTimestamp);
  const endTimestamp = Date.now();
  const maxAttempts = 5;
  const baseDelayMs = 500;
  const newData: OHLCV[] = [];

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const shouldRetry = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('429') ||
      message.toLowerCase().includes('rate limit') ||
      message.toLowerCase().includes('timeout') ||
      message.toLowerCase().includes('timed out') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ECONNRESET') ||
      message.includes('ENOTFOUND')
    );
  };

  const fetchWithRetry = async (sinceValue: number) => {
    let attempt = 0;
    while (attempt < maxAttempts) {
      try {
        return await exchange.fetchOHLCV(symbol, timeframe, sinceValue, limit);
      } catch (error) {
        attempt += 1;
        if (!shouldRetry(error) || attempt >= maxAttempts) {
          throw error;
        }
        const backoff = baseDelayMs * Math.pow(2, attempt - 1);
        await delay(backoff);
      }
    }
    return [];
  };

  let nextSince = startTimestamp;
  while (nextSince <= endTimestamp) {
    const data = await fetchWithRetry(nextSince);
    if (!data || data.length === 0) {
      break;
    }

    const batch: OHLCV[] = data.map((d: any) => ({
      timestamp: d[0],
      open: d[1],
      high: d[2],
      low: d[3],
      close: d[4],
      volume: d[5],
    }));
    newData.push(...batch);

    const latestTimestamp = Math.max(...batch.map(d => d.timestamp));
    if (latestTimestamp <= nextSince) {
      break;
    }
    if (latestTimestamp >= endTimestamp) {
      break;
    }
    nextSince = latestTimestamp + 1;
  }

  const mergedByTimestamp = new Map<number, OHLCV>();
  cachedData.forEach(item => mergedByTimestamp.set(item.timestamp, item));
  newData.forEach(item => mergedByTimestamp.set(item.timestamp, item));

  const mergedData = Array.from(mergedByTimestamp.values()).sort((a, b) => a.timestamp - b.timestamp);
  const serialized = mergedData.map(item => JSON.stringify(item)).join('\n');
  fs.writeFileSync(cachePath, serialized + (serialized.length ? '\n' : ''));

  return mergedData;
}
