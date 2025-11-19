import ccxt from 'ccxt';
import { ExchangeClient } from './exchangeBase';
import { Candle, PortfolioAsset } from '../core/types';

export class GateClient implements ExchangeClient {
  name = 'gate';
  private exchange: ccxt.gate;

  constructor(apiKey?: string, apiSecret?: string) {
    this.exchange = new ccxt.gate({
      apiKey: apiKey || process.env.GATE_API_KEY,
      secret: apiSecret || process.env.GATE_API_SECRET,
      enableRateLimit: true,
    });
  }

  async fetchCandles(symbol: string, timeframe: string, limit: number = 200): Promise<Candle[]> {
    const ohlcv = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    
    return ohlcv.map((candle) => ({
      timestamp: candle[0],
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: candle[5],
      timeframe,
      symbol,
    }));
  }

  async fetchBalance(): Promise<PortfolioAsset[]> {
    const balance = await this.exchange.fetchBalance();
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
    const ticker = await this.exchange.fetchTicker(symbol);
    return ticker.last || 0;
  }
}
