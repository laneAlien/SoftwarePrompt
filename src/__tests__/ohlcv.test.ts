import fs from 'fs';
import path from 'path';
import ccxt from 'ccxt';
import { fetchOHLCV } from '../real/ohlcv';

jest.mock('ccxt', () => ({
  __esModule: true,
  default: {},
}));

const intervalMs = 60 * 1000;
let endTimestamp = 0;

class FakeExchange {
  parseTimeframe(): number {
    return 60;
  }

  parse8601(value: string): number {
    return Date.parse(value);
  }

  async fetchOHLCV(_symbol: string, _timeframe: string, since: number, limit: number): Promise<any[]> {
    const candles: any[] = [];
    for (let ts = since; ts <= endTimestamp && candles.length < limit; ts += intervalMs) {
      candles.push([ts, 1, 2, 0.5, 1.5, 100]);
    }
    return candles;
  }
}

describe('fetchOHLCV', () => {
  const dataDir = path.join(process.cwd(), 'data');

  beforeEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    (ccxt as any).fake = FakeExchange;
  });

  it('deduplicates cached candles and fills missing intervals', async () => {
    const start = new Date('2024-01-01T00:00:00Z');
    const end = new Date(start.getTime() + 2 * intervalMs);
    endTimestamp = end.getTime();

    const cachePath = path.join(
      dataDir,
      'ohlcv',
      'fake',
      'BTC_USDT',
      '1m.jsonl'
    );
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const cached = [
      { timestamp: start.getTime(), open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { timestamp: start.getTime(), open: 2, high: 2, low: 2, close: 2, volume: 2 },
      { timestamp: start.getTime() + 2 * intervalMs, open: 3, high: 3, low: 3, close: 3, volume: 3 },
    ];
    fs.writeFileSync(cachePath, cached.map(row => `${JSON.stringify(row)}\n`).join(''), 'utf-8');

    const result = await fetchOHLCV('fake', 'BTC/USDT', '1m', start.toISOString(), 1000, {
      until: end.toISOString(),
      rebuildCache: true,
    });

    const timestamps = result.map(candle => candle.timestamp);
    expect(timestamps).toEqual([
      start.getTime(),
      start.getTime() + intervalMs,
      start.getTime() + 2 * intervalMs,
    ]);
    expect(new Set(timestamps).size).toBe(3);
    expect(result[0].open).toBe(2);
  });
});
