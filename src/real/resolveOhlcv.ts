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
  log?: (msg: string) => void;
}

export interface ResolveOhlcvStats {
  cacheLoadedCount: number;
  fetchedCount: number;
  dedupDroppedCount: number;
  gapsDetectedCount: number;
  gapsFilledCount: number;
  wroteCache: boolean;
  cachePath: string;
  cacheCoverageStart?: number;
  cacheCoverageEnd?: number;
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

function mergeCandlesWithStats(
  existing: OHLCV[],
  incoming: OHLCV[]
): { merged: OHLCV[]; dedupDroppedCount: number } {
  const map = new Map<number, OHLCV>();
  existing.forEach((candle) => map.set(candle.timestamp, candle));
  let dedupDroppedCount = 0;
  incoming.forEach((candle) => {
    if (map.has(candle.timestamp)) {
      dedupDroppedCount += 1;
    }
    map.set(candle.timestamp, candle);
  });
  return { merged: sortByTimestamp(Array.from(map.values())), dedupDroppedCount };
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
  options?: {
    verbose?: boolean;
    log?: (msg: string) => void;
    onBatch?: (info: { since: number; count: number; lastTimestamp?: number }) => void;
  }
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
          if (options?.verbose) {
            console.warn(`fetchOHLCV retry ${attempt}/3:`, (error as Error).message || error);
          }
        },
      }
    );
    if (!batch.length) break;
    batch.forEach((row) => all.push(mapToCandle(row)));
    const lastTimestamp = batch[batch.length - 1]?.[0];
    options?.onBatch?.({ since: fetchSince, count: batch.length, lastTimestamp });
    if (options?.verbose && options.log) {
      options.log(
        `[OHLCV] fetch batch since=${new Date(fetchSince).toISOString()} count=${batch.length}`
      );
    }
    if (batch.length < 2) break;
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
  options?: { verbose?: boolean; log?: (msg: string) => void }
): Promise<OHLCV[]> {
  const batch = await withRetry(
    () => exchange.fetchOHLCV(symbol, timeframe, undefined, limit),
    {
      onRetry: (attempt, error) => {
        if (options?.verbose) {
          console.warn(`fetchOHLCV retry ${attempt}/3:`, (error as Error).message || error);
        }
      },
    }
  );
  if (options?.verbose && options.log) {
    options.log(`[OHLCV] fetch latest count=${batch.length}`);
  }
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

function formatCoverage(start?: number, end?: number): string {
  if (!start || !end) return 'n/a';
  return `${new Date(start).toISOString()}..${new Date(end).toISOString()}`;
}

function buildMissingSummary(
  gaps: Array<{ start: number; end: number }>,
  requestedStart: number,
  requestedEnd: number
): string {
  if (!gaps.length) return 'none';
  const parts: string[] = [];
  const hasHead = gaps.some((gap) => gap.start === requestedStart);
  const hasTail = gaps.some((gap) => gap.end === requestedEnd);
  const internalCount = gaps.filter((gap) => gap.start !== requestedStart && gap.end !== requestedEnd).length;
  if (hasHead) parts.push('head');
  if (hasTail) parts.push('tail');
  if (internalCount > 0) parts.push(`gaps=${internalCount}`);
  return parts.join(' ');
}

export async function resolveOhlcvWithStats(
  params: ResolveOhlcvParams
): Promise<{ candles: OHLCV[]; stats: ResolveOhlcvStats }> {
  const {
    symbol,
    timeframe,
    source = 'auto',
    rebuildCache = false,
    fillGaps = false,
    limit = DEFAULT_LIMIT,
    verbose,
    log,
  } = params;
  const logFn = log ?? console.log;
  const logInfo = (message: string): void => {
    if (!logFn) return;
    logFn(`[OHLCV] ${message}`);
  };
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
  const existingSorted = sortByTimestamp([...existing]);
  const stats: ResolveOhlcvStats = {
    cacheLoadedCount: 0,
    fetchedCount: 0,
    dedupDroppedCount: 0,
    gapsDetectedCount: 0,
    gapsFilledCount: 0,
    wroteCache: false,
    cachePath,
    cacheCoverageStart: existingSorted[0]?.timestamp,
    cacheCoverageEnd: existingSorted[existingSorted.length - 1]?.timestamp,
  };

  if (source === 'auto') {
    logInfo(`source=auto exchange=${exchangeId} symbol=${symbol} tf=${timeframe}`);
  }

  if (source === 'cache') {
    const filtered = sortByTimestamp(filterRange(existing, sinceTimestamp, untilTimestamp));
    stats.cacheLoadedCount = filtered.length;
    ensureCacheCoverage(filtered, sinceTimestamp, untilTimestamp, intervalMs);
    return { candles: applyLimit(filtered, limit), stats };
  }

  if (source === 'exchange') {
    const fetched =
      sinceTimestamp === undefined
        ? await fetchLatest(exchange, symbol, timeframe, limit, { verbose, log: logFn })
        : await fetchRange(exchange, symbol, timeframe, sinceTimestamp, untilTimestamp ?? Date.now(), limit, {
            verbose,
            log: logFn,
          });
    stats.fetchedCount = fetched.length;
    const mergeResult = rebuildCache
      ? { merged: fetched, dedupDroppedCount: 0 }
      : mergeCandlesWithStats(existing, fetched);
    stats.dedupDroppedCount = mergeResult.dedupDroppedCount;
    if (mergeResult.merged.length) {
      writeJsonl(cachePath, mergeResult.merged);
      stats.wroteCache = true;
    }
    const filtered = sortByTimestamp(filterRange(mergeResult.merged, sinceTimestamp, untilTimestamp));
    return { candles: applyLimit(filtered, limit), stats };
  }

  if (rebuildCache) {
    const fetched =
      sinceTimestamp === undefined
        ? await fetchLatest(exchange, symbol, timeframe, limit, { verbose, log: logFn })
        : await fetchRange(exchange, symbol, timeframe, sinceTimestamp, untilTimestamp ?? Date.now(), limit, {
            verbose,
            log: logFn,
          });
    stats.fetchedCount = fetched.length;
    if (fetched.length) {
      writeJsonl(cachePath, fetched);
      stats.wroteCache = true;
    }
    const filtered = sortByTimestamp(filterRange(fetched, sinceTimestamp, untilTimestamp));
    return { candles: applyLimit(filtered, limit), stats };
  }

  if (sinceTimestamp === undefined) {
    const cachedSorted = sortByTimestamp([...existing]);
    if (cachedSorted.length >= limit) {
      stats.cacheLoadedCount = cachedSorted.length;
      if (source === 'auto') {
        logInfo(`cache=${cachePath} loaded=${stats.cacheLoadedCount} range=${formatCoverage(
          stats.cacheCoverageStart,
          stats.cacheCoverageEnd
        )}`);
        logInfo('missing: none fetched=0');
        logInfo(`merge: total=${cachedSorted.length} dedup=0 gapsFilled=0 wroteCache=false`);
      }
      return { candles: cachedSorted.slice(-limit), stats };
    }
    const fetched = await fetchLatest(exchange, symbol, timeframe, limit, { verbose, log: logFn });
    stats.fetchedCount = fetched.length;
    const mergeResult = mergeCandlesWithStats(existing, fetched);
    stats.dedupDroppedCount = mergeResult.dedupDroppedCount;
    if (mergeResult.merged.length) {
      writeJsonl(cachePath, mergeResult.merged);
      stats.wroteCache = true;
    }
    if (source === 'auto') {
      stats.cacheLoadedCount = cachedSorted.length;
      logInfo(
        `cache=${cachePath} loaded=${stats.cacheLoadedCount} range=${formatCoverage(
          stats.cacheCoverageStart,
          stats.cacheCoverageEnd
        )}`
      );
      logInfo(`missing: tail fetched=${stats.fetchedCount}`);
      logInfo(
        `merge: total=${mergeResult.merged.length} dedup=${stats.dedupDroppedCount} gapsFilled=${stats.gapsFilledCount} wroteCache=${stats.wroteCache}`
      );
    }
    return { candles: applyLimit(sortByTimestamp(filterRange(mergeResult.merged, sinceTimestamp, untilTimestamp)), limit), stats };
  }

  const requestedEnd = untilTimestamp ?? Date.now();
  const cachedRange = sortByTimestamp(filterRange(existing, sinceTimestamp, requestedEnd));
  const gaps = findGaps(cachedRange, sinceTimestamp, requestedEnd, intervalMs);
  stats.cacheLoadedCount = cachedRange.length;
  stats.gapsDetectedCount = gaps.length;
  if (source === 'auto') {
    logInfo(
      `cache=${cachePath} loaded=${stats.cacheLoadedCount} range=${formatCoverage(
        stats.cacheCoverageStart,
        stats.cacheCoverageEnd
      )}`
    );
  }
  if (gaps.length === 0) {
    if (source === 'auto') {
      logInfo('missing: none fetched=0');
      logInfo(
        `merge: total=${cachedRange.length} dedup=0 gapsFilled=0 wroteCache=false`
      );
    }
    return { candles: applyLimit(cachedRange, limit), stats };
  }
  const missingRanges = resolveMissingRanges(cachedRange, sinceTimestamp, requestedEnd, intervalMs, fillGaps);
  let fetched: OHLCV[] = [];
  let batchCount = 0;

  for (const range of missingRanges) {
    if (verbose && logFn) {
      logFn(
        `[OHLCV] fetch segment since=${new Date(range.start).toISOString()} until=${new Date(range.end).toISOString()}`
      );
    }
    const rangeCandles = await fetchRange(exchange, symbol, timeframe, range.start, range.end, limit, {
      verbose,
      log: logFn,
      onBatch: () => {
        batchCount += 1;
      },
    });
    fetched = fetched.concat(rangeCandles);
  }

  stats.fetchedCount = fetched.length;
  const mergeResult = mergeCandlesWithStats(existing, fetched);
  stats.dedupDroppedCount = mergeResult.dedupDroppedCount;
  if (fillGaps) {
    const remaining = findGaps(
      sortByTimestamp(filterRange(mergeResult.merged, sinceTimestamp, requestedEnd)),
      sinceTimestamp,
      requestedEnd,
      intervalMs
    );
    stats.gapsFilledCount = Math.max(stats.gapsDetectedCount - remaining.length, 0);
  }
  const merged = mergeResult.merged;
  if (merged.length) {
    writeJsonl(cachePath, merged);
    stats.wroteCache = true;
  }
  const filtered = sortByTimestamp(filterRange(merged, sinceTimestamp, requestedEnd));
  const remainingGaps = findGaps(filtered, sinceTimestamp, requestedEnd, intervalMs);
  if (source === 'auto') {
    logInfo(`missing: ${buildMissingSummary(gaps, sinceTimestamp, requestedEnd)} fetched=${stats.fetchedCount}`);
    logInfo(
      `merge: total=${filtered.length} dedup=${stats.dedupDroppedCount} gapsFilled=${stats.gapsFilledCount} wroteCache=${stats.wroteCache}`
    );
    if (verbose && logFn) {
      logFn(`[OHLCV] fetch batches=${batchCount}`);
    }
  }
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
  return { candles: applyLimit(filtered, limit), stats };
}

export async function resolveOhlcv(params: ResolveOhlcvParams): Promise<OHLCV[]> {
  const result = await resolveOhlcvWithStats(params);
  return result.candles;
}
