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

export interface FetchOHLCVOptions {
  limit?: number;
  until?: string;
  rebuildCache?: boolean;
  maxRetries?: number;
  backoffMs?: number;
}

const DEFAULT_LIMIT = 1000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const message = (error as Error).message?.toLowerCase() ?? '';
  return (
    message.includes('rate limit') ||
    message.includes('rate') ||
    message.includes('timeout') ||
    message.includes('network') ||
    message.includes('ddos') ||
    message.includes('429')
  );
}

function parseJsonl(filePath: string): OHLCV[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function writeJsonl(filePath: string, data: OHLCV[]): void {
  const stream = fs.createWriteStream(filePath, { flags: 'w' });
  data.forEach(row => stream.write(`${JSON.stringify(row)}\n`));
  stream.end();
}

async function fetchWithRetry(
  exchange: ccxt.Exchange,
  symbol: string,
  timeframe: string,
  since: number,
  limit: number,
  maxRetries: number,
  backoffMs: number
): Promise<ccxt.OHLCV[]> {
  let attempt = 0;
  while (true) {
    try {
      return await exchange.fetchOHLCV(symbol, timeframe, since, limit);
    } catch (error) {
      attempt += 1;
      if (!isRetryableError(error) || attempt > maxRetries) {
        throw error;
      }
      const delay = backoffMs * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
}

export async function fetchOHLCV(
  exchangeId: string,
  symbol: string,
  timeframe: string,
  since: string,
  limit: number = DEFAULT_LIMIT,
  options: FetchOHLCVOptions = {}
): Promise<OHLCV[]> {
  const exchange = new (ccxt as any)[exchangeId]({
    enableRateLimit: true,
  });

  const sinceTimestamp = exchange.parse8601(since);
  const untilTimestamp = options.until ? exchange.parse8601(options.until) : Date.now();
  const cachePath = path.join('data', 'ohlcv', exchangeId, symbol.replace('/', '_'), `${timeframe}.jsonl`);
  
  // Ensure cache directory exists
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });

  if (options.rebuildCache && fs.existsSync(cachePath)) {
    fs.unlinkSync(cachePath);
  }

  let cachedData: OHLCV[] = parseJsonl(cachePath);
  const cacheByTimestamp = new Map<number, OHLCV>();
  cachedData.forEach(candle => cacheByTimestamp.set(candle.timestamp, candle));

  // Find the last cached timestamp
  const lastCachedTimestamp = cachedData.length > 0 ? cachedData[cachedData.length - 1].timestamp : sinceTimestamp;
  let fetchSince = Math.max(sinceTimestamp, lastCachedTimestamp + 1);

  console.log(`Fetching ${symbol} from ${exchangeId}...`);
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const batchLimit = options.limit ?? limit;

  while (fetchSince < untilTimestamp) {
    const batch = await fetchWithRetry(exchange, symbol, timeframe, fetchSince, batchLimit, maxRetries, backoffMs);
    if (batch.length === 0) break;

    batch.forEach((d: any) => {
      const candle: OHLCV = {
        timestamp: d[0],
        open: d[1],
        high: d[2],
        low: d[3],
        close: d[4],
        volume: d[5],
      };
      cacheByTimestamp.set(candle.timestamp, candle);
    });

    const lastTimestamp = batch[batch.length - 1][0];
    fetchSince = lastTimestamp + 1;

    if (lastTimestamp >= untilTimestamp) break;
  }

  const merged = Array.from(cacheByTimestamp.values()).sort((a, b) => a.timestamp - b.timestamp);
  writeJsonl(cachePath, merged);

  return merged.filter(candle => candle.timestamp >= sinceTimestamp && candle.timestamp <= untilTimestamp);
}
