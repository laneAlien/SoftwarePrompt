import ccxt from 'ccxt';
import { ExchangeClient } from './exchangeBase';
import { Candle, PortfolioAsset } from '../core/types';
import { createExchangeOptions, withRetry } from './exchangeUtils';

export class KucoinClient implements ExchangeClient {
  name = 'kucoin';
  private exchange: ccxt.kucoin;
  private static marketsPromise?: Promise<void>;
  private static marketsLoaded = false;
  private candleCache = new Map<string, Candle[]>();

  constructor(apiKey?: string, apiSecret?: string, passphrase?: string) {
    this.exchange = new ccxt.kucoin(
      createExchangeOptions({
        apiKey: apiKey || process.env.KUCOIN_API_KEY,
        secret: apiSecret || process.env.KUCOIN_API_SECRET,
        password: passphrase || process.env.KUCOIN_API_PASSPHRASE,
      })
    );
  }

  async fetchCandles(symbol: string, timeframe: string, limit: number = 200): Promise<Candle[]> {
    await this.ensureMarkets();

    const cacheKey = `${symbol}:${timeframe}:${limit}`;
    const cached = this.candleCache.get(cacheKey);
    if (cached) return cached;

    try {
      const ohlcv = await withRetry(() => this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit), {
        onRetry: (attempt, error) =>
          console.warn(`KuCoin fetchOHLCV retry ${attempt}/${3}:`, (error as Error).message || error),
      });

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

      this.candleCache.set(cacheKey, candles);
      return candles;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown KuCoin error';
      throw new Error(`Failed to fetch KuCoin candles for ${symbol} (${timeframe}): ${message}`);
    }
  }

  async fetchBalance(): Promise<PortfolioAsset[]> {
    await this.ensureMarkets();

    const balance = await withRetry(() => this.exchange.fetchBalance(), {
      onRetry: (attempt, error) =>
        console.warn(`KuCoin fetchBalance retry ${attempt}/${3}:`, (error as Error).message || error),
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
        console.warn(`KuCoin fetchTicker retry ${attempt}/${3}:`, (error as Error).message || error),
    });
    return ticker.last || 0;
  }

  private async ensureMarkets(): Promise<void> {
    if (!KucoinClient.marketsPromise || !KucoinClient.marketsLoaded) {
      KucoinClient.marketsPromise = this.exchange
        .loadMarkets(true)
        .then(() => {
          KucoinClient.marketsLoaded = true;
        })
        .catch((error) => {
          KucoinClient.marketsLoaded = false;
          throw error;
        });
    }

    return KucoinClient.marketsPromise;
  }
}
