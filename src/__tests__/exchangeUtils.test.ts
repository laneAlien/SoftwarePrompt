import { fetchFullOHLCV } from '../real/exchangeUtils';

describe('fetchFullOHLCV', () => {
  const calls: number[] = [];
  const fakeExchange: any = {
    id: 'fake',
    parseTimeframe: () => 60,
    fetchOHLCV: async (_symbol: string, _tf: string, since: number) => {
      calls.push(since);
      if (calls.length > 2) return [];
      const start = since;
      return [
        [start, 1, 1, 1, 1, 1],
        [start + 60 * 1000, 1, 1, 1, 1, 1],
      ];
    },
  };

  it('paginates until target time and caches results', async () => {
    const from = Date.now();
    const to = from + 3 * 60 * 1000;
    const first = await fetchFullOHLCV(fakeExchange, 'BTC/USDT', '1m', from, to);
    const second = await fetchFullOHLCV(fakeExchange, 'BTC/USDT', '1m', from, to);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });
});
