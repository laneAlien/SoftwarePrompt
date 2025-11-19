import { Candle, Position, PortfolioAsset } from '../core/types';

export interface ExchangeClient {
  name: string;
  fetchCandles(symbol: string, timeframe: string, limit?: number): Promise<Candle[]>;
  fetchBalance(): Promise<PortfolioAsset[]>;
  fetchPositions?(symbol?: string): Promise<Position[]>;
  getCurrentPrice(symbol: string): Promise<number>;
}
