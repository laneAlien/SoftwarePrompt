import { analyzeLedger, LedgerEntry } from '../core/importLedger';

describe('analyzeLedger', () => {
  it('aggregates turnover, fees, and realized PnL', () => {
    const entries: LedgerEntry[] = [
      {
        time: '2024-01-01T00:00:00Z',
        action: 'buy',
        actionType: 'trade',
        side: 'buy',
        amount: 1,
        currency: 'BTC',
        tradeId: 't1',
      },
      {
        time: '2024-01-01T00:00:00Z',
        action: 'buy',
        actionType: 'trade',
        side: 'buy',
        amount: -100,
        currency: 'USDT',
        tradeId: 't1',
      },
      {
        time: '2024-01-01T01:00:00Z',
        action: 'sell',
        actionType: 'trade',
        side: 'sell',
        amount: -1,
        currency: 'BTC',
        tradeId: 't2',
      },
      {
        time: '2024-01-01T01:00:00Z',
        action: 'sell',
        actionType: 'trade',
        side: 'sell',
        amount: 120,
        currency: 'USDT',
        tradeId: 't2',
      },
      {
        time: '2024-01-01T02:00:00Z',
        action: 'buy',
        actionType: 'trade',
        side: 'buy',
        amount: 10,
        currency: 'GT',
        tradeId: 'gt1',
      },
      {
        time: '2024-01-01T02:00:00Z',
        action: 'buy',
        actionType: 'trade',
        side: 'buy',
        amount: -2,
        currency: 'USDT',
        tradeId: 'gt1',
      },
      {
        time: '2024-01-01T02:30:00Z',
        action: 'fee',
        actionType: 'fee',
        amount: -1,
        currency: 'USDT',
      },
      {
        time: '2024-01-01T02:30:00Z',
        action: 'fee',
        actionType: 'fee',
        amount: -0.1,
        currency: 'GT',
      },
    ];

    const summary = analyzeLedger(entries);

    expect(summary.tradesCount).toBe(3);
    expect(summary.turnover).toBe(222);
    expect(summary.totalFeesInQuote).toBeCloseTo(1.02, 6);
    expect(summary.realizedPnlGross).toBeCloseTo(20, 6);
    expect(summary.realizedPnlNet).toBeCloseTo(18.98, 6);
    expect(summary.feeRatio).toBeCloseTo(1.02 / 222, 6);
  });
});
