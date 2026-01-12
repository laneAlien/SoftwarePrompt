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
  const lastTimestamp = cachedData.length > 0 ? cachedData[cachedData.length - 1].timestamp : sinceTimestamp;
  
  if (lastTimestamp >= Date.now() - 60000) {
      return cachedData;
  }

  console.log(`Fetching ${symbol} from ${exchangeId}...`);
  const data = await exchange.fetchOHLCV(symbol, timeframe, lastTimestamp, limit);
  
  const newData: OHLCV[] = data.map((d: any) => ({
    timestamp: d[0],
    open: d[1],
    high: d[2],
    low: d[3],
    close: d[4],
    volume: d[5],
  }));

  // Append new data to cache
  const uniqueNewData = newData.filter(d => d.timestamp > lastTimestamp);
  if (uniqueNewData.length > 0) {
      const stream = fs.createWriteStream(cachePath, { flags: 'a' });
      uniqueNewData.forEach(d => stream.write(JSON.stringify(d) + '\n'));
      stream.end();
  }

  return [...cachedData, ...uniqueNewData];
}
