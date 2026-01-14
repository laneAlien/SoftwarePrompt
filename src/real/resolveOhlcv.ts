import ccxt, { Exchange, OHLCV as RawOHLCV } from 'ccxt';
import fs from 'fs';
import path from 'path';
import { OHLCV } from './ohlcv';
import { createExchangeOptions, withRetry } from './exchangeUtils';

export type OhlcvSource = 'cache' | 'exchange' | 'auto';

export interface ResolveOhlcvParams {
  exchange: Exchange | string;
  symbol: string;
  timeframe: string;
  since?: string | number;
  until?: string | number;
  limit?: number;
  source?: OhlcvSource;
  rebuildCache?: boolean;
  fillGaps?: boolean;
  rateLimit?: boolean;
  verbose?: boolean;
}

const DEFAULT_LIMIT = 1000;

function resolveOhlcvCachePath(exchangeId: string, symbol: string, timeframe: string): string {
  return path.join('data', 'ohlcv', exchangeId, symbol.replace('/', '_'), `${timeframe}.jsonl`);
}

function parseTimestamp(value?: string | number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJsonl(filePath: string): OHLCV[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJsonl(filePath: string, data: OHLCV[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = fs.createWriteStream(filePath, { flags: 'w' });
  data.forEach((row) => stream.write(`${JSON.stringify(row)}\n`));
  stream.end();
}

function sortByTimestamp(data: OHLCV[]): OHLCV[] {
  return data.sort((a, b) => a.timestamp - b.timestamp);
}

function mapToCandle(row: RawOHLCV): OHLCV {
  return {
    timestamp: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

function mergeCandles(existing: OHLCV[], incoming: OHLCV[]): OHLCV[] {
  const map = new Map<number, OHLCV>();
  existing.forEach((candle) => map.set(candle.timestamp, candle));
  incoming.forEach((candle) => map.set(candle.timestamp, candle));
  return sortByTimestamp(Array.from(map.values()));
}

function filterRange(candles: OHLCV[], since?: number, until?: number): OHLCV[] {
  return candles.filter((candle) => {
    if (since !== undefined && candle.timestamp < since) return false;
    if (until !== undefined && candle.timestamp > until) return false;
    return true;
  });
}

function applyLimit(candles: OHLCV[], limit?: number): OHLCV[] {
  if (!limit || candles.length <= limit) return candles;
  return candles.slice(0, limit);
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

  return gaps.filter((gap) => gap.start <= gap.end);
}

async function fetchRange(
  exchange: Exchange,
  symbol: string,
  timeframe: string,
  since: number,
  until: number,
  limit: number,
  verbose?: boolean
): Promise<OHLCV[]> {
  const intervalMs = exchange.parseTimeframe(timeframe) * 1000;
  if (!intervalMs || Number.isNaN(intervalMs)) {
    throw new Error(`Unable to parse timeframe: ${timeframe}`);
  }
  let fetchSince = since;
  const all: OHLCV[] = [];

  while (fetchSince <= until) {
    const batch = await withRetry(
      () => exchange.fetchOHLCV(symbol, timeframe, fetchSince, limit),
      {
        onRetry: (attempt, error) => {
          if (verbose) {
            console.warn(`fetchOHLCV retry ${attempt}/3:`, (error as Error).message || error);
          }
        },
      }
    );
    if (!batch.length) break;
    batch.forEach((row) => all.push(mapToCandle(row)));
    if (batch.length < 2) break;
    const lastTimestamp = batch[batch.length - 1][0];
    if (!lastTimestamp || lastTimestamp <= fetchSince) break;
    if (lastTimestamp >= until) break;
    fetchSince = lastTimestamp + intervalMs;
  }

  return all;
}

async function fetchLatest(
  exchange: Exchange,
  symbol: string,
  timeframe: string,
  limit: number,
  verbose?: boolean
): Promise<OHLCV[]> {
  const batch = await withRetry(
    () => exchange.fetchOHLCV(symbol, timeframe, undefined, limit),
    {
      onRetry: (attempt, error) => {
        if (verbose) {
          console.warn(`fetchOHLCV retry ${attempt}/3:`, (error as Error).message || error);
        }
      },
    }
  );
  return batch.map((row) => mapToCandle(row));
}

function resolveMissingRanges(
  cached: OHLCV[],
  start: number,
  end: number,
  intervalMs: number,
  fillGaps?: boolean
): Array<{ start: number; end: number }> {
  if (cached.length === 0) {
    return [{ start, end }];
  }

  if (fillGaps) {
    return findGaps(cached, start, end, intervalMs);
  }

  const ranges: Array<{ start: number; end: number }> = [];
  const sorted = sortByTimestamp([...cached]);
  if (sorted[0].timestamp > start) {
    ranges.push({ start, end: sorted[0].timestamp - intervalMs });
  }
  const last = sorted[sorted.length - 1];
  if (last.timestamp < end) {
    ranges.push({ start: last.timestamp + intervalMs, end });
  }
  return ranges.filter((range) => range.start <= range.end);
}

function resolveInternalGaps(
  cached: OHLCV[],
  start: number,
  end: number,
  intervalMs: number
): Array<{ start: number; end: number }> {
  const gaps = findGaps(cached, start, end, intervalMs);
  return gaps.filter((gap) => gap.start !== start && gap.end !== end);
}

function ensureCacheCoverage(
  candles: OHLCV[],
  since: number | undefined,
  until: number | undefined,
  intervalMs: number
): void {
  if (!candles.length) {
    throw new Error('Cache does not contain any candles for the requested range.');
  }

  if (since !== undefined && candles[0].timestamp > since) {
    throw new Error('Cache does not include the requested start timestamp.');
  }

  if (until !== undefined && candles[candles.length - 1].timestamp + intervalMs < until) {
    throw new Error('Cache does not include the requested end timestamp.');
  }

  if (since !== undefined && until !== undefined) {
    const gaps = findGaps(candles, since, until, intervalMs);
    if (gaps.length > 0) {
      throw new Error(
        `Cache is missing intervals: ${gaps.map((gap) => `${gap.start}..${gap.end}`).join(', ')}`
      );
    }
  }
}

function resolveExchange(exchangeInput: Exchange | string, rateLimit?: boolean): Exchange {
  if (typeof exchangeInput !== 'string') {
    return exchangeInput;
  }
  const ExchangeCtor = (ccxt as any)[exchangeInput];
  if (!ExchangeCtor) {
    throw new Error(`Unsupported exchange: ${exchangeInput}`);
  }
  return new ExchangeCtor(
    createExchangeOptions({
      enableRateLimit: rateLimit ?? true,
    })
  );
}

export async function resolveOhlcv(params: ResolveOhlcvParams): Promise<OHLCV[]> {
  const {
    symbol,
    timeframe,
    source = 'auto',
    rebuildCache = false,
    fillGaps = false,
    limit = DEFAULT_LIMIT,
    verbose,
  } = params;
  const exchange = resolveExchange(params.exchange, params.rateLimit);
  const exchangeId = exchange.id;
  const intervalMs = exchange.parseTimeframe(timeframe) * 1000;
  if (!intervalMs || Number.isNaN(intervalMs)) {
    throw new Error(`Unable to parse timeframe: ${timeframe}`);
  }

  const cachePath = resolveOhlcvCachePath(exchangeId, symbol, timeframe);
  const sinceTimestamp = parseTimestamp(params.since);
  const untilTimestamp = parseTimestamp(params.until) ?? (sinceTimestamp !== undefined ? Date.now() : undefined);

  const existing = rebuildCache ? [] : parseJsonl(cachePath);

  if (source === 'cache') {
    const filtered = sortByTimestamp(filterRange(existing, sinceTimestamp, untilTimestamp));
    ensureCacheCoverage(filtered, sinceTimestamp, untilTimestamp, intervalMs);
    return applyLimit(filtered, limit);
  }

  if (source === 'exchange') {
    const fetched =
      sinceTimestamp === undefined
        ? await fetchLatest(exchange, symbol, timeframe, limit, verbose)
        : await fetchRange(exchange, symbol, timeframe, sinceTimestamp, untilTimestamp ?? Date.now(), limit, verbose);
    const merged = rebuildCache ? fetched : mergeCandles(existing, fetched);
    if (merged.length) {
      writeJsonl(cachePath, merged);
    }
    const filtered = sortByTimestamp(filterRange(merged, sinceTimestamp, untilTimestamp));
    return applyLimit(filtered, limit);
  }

  if (rebuildCache) {
    const fetched =
      sinceTimestamp === undefined
        ? await fetchLatest(exchange, symbol, timeframe, limit, verbose)
        : await fetchRange(exchange, symbol, timeframe, sinceTimestamp, untilTimestamp ?? Date.now(), limit, verbose);
    if (fetched.length) {
      writeJsonl(cachePath, fetched);
    }
    const filtered = sortByTimestamp(filterRange(fetched, sinceTimestamp, untilTimestamp));
    return applyLimit(filtered, limit);
  }

  if (sinceTimestamp === undefined) {
    const cachedSorted = sortByTimestamp([...existing]);
    if (cachedSorted.length >= limit) {
      return cachedSorted.slice(-limit);
    }
    const fetched = await fetchLatest(exchange, symbol, timeframe, limit, verbose);
    const merged = mergeCandles(existing, fetched);
    if (merged.length) {
      writeJsonl(cachePath, merged);
    }
    return applyLimit(sortByTimestamp(filterRange(merged, sinceTimestamp, untilTimestamp)), limit);
  }

  const requestedEnd = untilTimestamp ?? Date.now();
  const cachedRange = sortByTimestamp(filterRange(existing, sinceTimestamp, requestedEnd));
  const gaps = findGaps(cachedRange, sinceTimestamp, requestedEnd, intervalMs);
  if (gaps.length === 0) {
    return applyLimit(cachedRange, limit);
  }
  const missingRanges = resolveMissingRanges(cachedRange, sinceTimestamp, requestedEnd, intervalMs, fillGaps);
  let fetched: OHLCV[] = [];

  for (const range of missingRanges) {
    if (verbose) {
      console.log(`Fetching ${symbol} ${timeframe} ${range.start}..${range.end}`);
    }
    const rangeCandles = await fetchRange(exchange, symbol, timeframe, range.start, range.end, limit, verbose);
    fetched = fetched.concat(rangeCandles);
  }

  const merged = mergeCandles(existing, fetched);
  if (merged.length) {
    writeJsonl(cachePath, merged);
  }
  const filtered = sortByTimestamp(filterRange(merged, sinceTimestamp, requestedEnd));
  const remainingGaps = findGaps(filtered, sinceTimestamp, requestedEnd, intervalMs);
  if (!fillGaps) {
    const internalGaps = resolveInternalGaps(filtered, sinceTimestamp, requestedEnd, intervalMs);
    if (internalGaps.length > 0) {
      throw new Error(
        `Cache has internal gaps for ${symbol} ${timeframe}. Use --fill-gaps to fetch missing intervals.`
      );
    }
  } else if (remainingGaps.length > 0) {
    throw new Error(
      `Missing OHLCV intervals for ${symbol} ${timeframe}: ${remainingGaps
        .map((gap) => `${gap.start}..${gap.end}`)
        .join(', ')}`
    );
  }
  return applyLimit(filtered, limit);
}
