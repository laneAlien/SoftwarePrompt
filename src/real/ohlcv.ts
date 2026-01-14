import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';
import { createExchangeOptions } from './exchangeUtils';

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

function getIntervalMs(exchange: ccxt.Exchange, timeframe: string): number {
  const seconds = exchange.parseTimeframe(timeframe);
  if (!seconds || Number.isNaN(seconds)) {
    throw new Error(`Unable to parse timeframe: ${timeframe}`);
  }
  return seconds * 1000;
}

function sortByTimestamp(data: OHLCV[]): OHLCV[] {
  return data.sort((a, b) => a.timestamp - b.timestamp);
}

function getExpectedEndTimestamp(start: number, end: number, intervalMs: number): number {
  if (end <= start) return start;
  return start + Math.floor((end - start) / intervalMs) * intervalMs;
}

function findGaps(
  data: OHLCV[],
  start: number,
  end: number,
  intervalMs: number
): Array<{ start: number; end: number }> {
  const gaps: Array<{ start: number; end: number }> = [];
  if (data.length === 0) {
    gaps.push({ start, end });
    return gaps;
  }

  let expected = start;
  for (const candle of data) {
    if (candle.timestamp < start || candle.timestamp > end) continue;
    if (candle.timestamp > expected) {
      gaps.push({ start: expected, end: candle.timestamp - intervalMs });
    }
    if (candle.timestamp >= expected) {
      expected = candle.timestamp + intervalMs;
    }
  }

  if (expected <= end) {
    gaps.push({ start: expected, end });
  }

  return gaps.filter(gap => gap.start <= gap.end);
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

async function fillGaps(
  exchange: ccxt.Exchange,
  symbol: string,
  timeframe: string,
  gaps: Array<{ start: number; end: number }>,
  limit: number,
  maxRetries: number,
  backoffMs: number,
  intervalMs: number,
  cacheByTimestamp: Map<number, OHLCV>
): Promise<void> {
  for (const gap of gaps) {
    let gapSince = gap.start;
    while (gapSince <= gap.end) {
      const batch = await fetchWithRetry(exchange, symbol, timeframe, gapSince, limit, maxRetries, backoffMs);
      if (batch.length === 0) {
        console.warn(`Empty response while filling gap ${gap.start}..${gap.end}.`);
        break;
      }

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
      if (lastTimestamp < gapSince) break;
      if (lastTimestamp >= gap.end) break;
      gapSince = lastTimestamp + intervalMs;
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
  const exchange = new (ccxt as any)[exchangeId](createExchangeOptions());

  const sinceTimestamp = exchange.parse8601(since);
  const untilTimestamp = options.until ? exchange.parse8601(options.until) : Date.now();
  const intervalMs = getIntervalMs(exchange, timeframe);
  const expectedUntilTimestamp = getExpectedEndTimestamp(sinceTimestamp, untilTimestamp, intervalMs);
  const cachePath = path.join('data', 'ohlcv', exchangeId, symbol.replace('/', '_'), `${timeframe}.jsonl`);
  
  // Ensure cache directory exists
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });

  if (options.rebuildCache && fs.existsSync(cachePath)) {
    fs.unlinkSync(cachePath);
  }

  let cachedData: OHLCV[] = sortByTimestamp(parseJsonl(cachePath));
  const cacheByTimestamp = new Map<number, OHLCV>();
  cachedData.forEach(candle => cacheByTimestamp.set(candle.timestamp, candle));

  // Find the last cached timestamp
  const lastCachedTimestamp =
    cachedData.length > 0 ? cachedData[cachedData.length - 1].timestamp : sinceTimestamp - intervalMs;
  let fetchSince = Math.max(sinceTimestamp, lastCachedTimestamp + intervalMs);

  console.log(`Fetching ${symbol} from ${exchangeId}...`);
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const batchLimit = options.limit ?? limit;

  while (fetchSince <= expectedUntilTimestamp) {
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
    fetchSince = lastTimestamp + intervalMs;

    const sorted = sortByTimestamp(Array.from(cacheByTimestamp.values()));
    const rangeEnd = Math.min(lastTimestamp, expectedUntilTimestamp);
    const gaps = findGaps(sorted, sinceTimestamp, rangeEnd, intervalMs);
    if (gaps.length > 0) {
      console.warn(
        `Detected gaps for ${symbol} ${timeframe}: ${gaps.map(gap => `${gap.start}..${gap.end}`).join(', ')}`
      );
      if (options.rebuildCache) {
        await fillGaps(
          exchange,
          symbol,
          timeframe,
          gaps,
          batchLimit,
          maxRetries,
          backoffMs,
          intervalMs,
          cacheByTimestamp
        );
      }
    }

    if (lastTimestamp >= expectedUntilTimestamp) break;
  }

  let merged = sortByTimestamp(Array.from(cacheByTimestamp.values()));
  let finalGaps = findGaps(merged, sinceTimestamp, expectedUntilTimestamp, intervalMs);
  if (finalGaps.length > 0) {
    const message = `Missing OHLCV intervals for ${symbol} ${timeframe}: ${finalGaps
      .map(gap => `${gap.start}..${gap.end}`)
      .join(', ')}`;
    console.warn(message);
    if (options.rebuildCache) {
      await fillGaps(
        exchange,
        symbol,
        timeframe,
        finalGaps,
        batchLimit,
        maxRetries,
        backoffMs,
        intervalMs,
        cacheByTimestamp
      );
      merged = sortByTimestamp(Array.from(cacheByTimestamp.values()));
      finalGaps = findGaps(merged, sinceTimestamp, expectedUntilTimestamp, intervalMs);
    }
  }
  if (finalGaps.length > 0) {
    throw new Error(
      `Missing OHLCV intervals for ${symbol} ${timeframe} after retries: ${finalGaps
        .map(gap => `${gap.start}..${gap.end}`)
        .join(', ')}`
    );
  }
  writeJsonl(cachePath, merged);

  return merged.filter(candle => candle.timestamp >= sinceTimestamp && candle.timestamp <= untilTimestamp);
}
