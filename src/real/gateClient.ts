import ccxt from 'ccxt';
import { ExchangeClient } from './exchangeBase';
import { Candle, PortfolioAsset } from '../core/types';
import { createExchangeOptions, withRetry, fetchFullOHLCV } from './exchangeUtils';

export class GateClient implements ExchangeClient {
  name = 'gate';
  private exchange: ccxt.gate;
  private static marketsPromise?: Promise<void>;
  private static marketsLoaded = false;
  private candleCache = new Map<string, Candle[]>();

  constructor(apiKey?: string, apiSecret?: string) {
    this.exchange = new ccxt.gate(
      createExchangeOptions({
        apiKey: apiKey || process.env.GATE_API_KEY,
        secret: apiSecret || process.env.GATE_API_SECRET,
      })
    );
  }

  async fetchCandles(
    symbol: string,
    timeframe: string,
    limit: number = 200,
    since?: number,
    to?: number,
    options: { skipCache?: boolean } = {}
  ): Promise<Candle[]> {
    await this.ensureMarkets();

    const cacheKey = `${symbol}:${timeframe}:${limit}:${since ?? 'recent'}:${to ?? 'now'}`;
    const cached = this.candleCache.get(cacheKey);
    if (cached && !options.skipCache) return cached;

    try {
      let ohlcv: any[];
      if (since && to) {
        ohlcv = await fetchFullOHLCV(this.exchange, symbol, timeframe, since, to, options);
      } else {
        ohlcv = await withRetry(() => this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit), {
          onRetry: (attempt, error) =>
            console.warn(`Gate.io fetchOHLCV retry ${attempt}/${3}:`, (error as Error).message || error),
        });
      }

      const candles = ohlcv.map((candle) => ({
        timestamp: candle[0],
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5],
        timeframe,
        symbol,
      }));

      if (!options.skipCache) {
        this.candleCache.set(cacheKey, candles);
      }
      return candles;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Gate.io error';
      throw new Error(`Failed to fetch Gate.io candles for ${symbol} (${timeframe}): ${message}`);
    }
  }

  async fetchBalance(): Promise<PortfolioAsset[]> {
    await this.ensureMarkets();

    const balance = await withRetry(() => this.exchange.fetchBalance(), {
      onRetry: (attempt, error) =>
        console.warn(`Gate.io fetchBalance retry ${attempt}/${3}:`, (error as Error).message || error),
    });
    const assets: PortfolioAsset[] = [];

    for (const [currency, amount] of Object.entries(balance.total)) {
      if (typeof amount === 'number' && amount > 0) {
        assets.push({
          symbol: currency,
          amount,
          type: 'spot',
          exchange: this.name,
        });
      }
    }

    return assets;
  }

  async getCurrentPrice(symbol: string): Promise<number> {
    await this.ensureMarkets();

    const ticker = await withRetry(() => this.exchange.fetchTicker(symbol), {
      onRetry: (attempt, error) =>
        console.warn(`Gate.io fetchTicker retry ${attempt}/${3}:`, (error as Error).message || error),
    });
    return ticker.last || 0;
  }

  private async ensureMarkets(): Promise<void> {
    if (!GateClient.marketsPromise || !GateClient.marketsLoaded) {
      GateClient.marketsPromise = this.exchange
        .loadMarkets(true)
        .then(() => {
          GateClient.marketsLoaded = true;
        })
        .catch((error) => {
          GateClient.marketsLoaded = false;
          throw error;
        });
    }

    return GateClient.marketsPromise;
  }
}
