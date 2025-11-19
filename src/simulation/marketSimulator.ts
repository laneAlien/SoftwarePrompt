import { Candle, MarketState } from '../core/types';

export class MarketSimulator {
  private candles: Candle[];
  private index: number;
  private symbol: string;
  private timeframe: string;

  constructor(symbol: string, timeframe: string, candles: Candle[]) {
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.candles = candles;
    this.index = 0;
  }

  hasNext(): boolean {
    return this.index < this.candles.length;
  }

  next(): MarketState {
    if (!this.hasNext()) {
      throw new Error('No more candles available in simulation');
    }

    const currentCandle = this.candles[this.index];
    this.index++;

    const windowSize = Math.min(100, this.index);
    const recentCandles = this.candles.slice(Math.max(0, this.index - windowSize), this.index);

    return {
      currentPrice: currentCandle.close,
      recentCandles,
      symbol: this.symbol,
      timeframe: this.timeframe,
    };
  }

  getHistory(windowSize: number): Candle[] {
    const start = Math.max(0, this.index - windowSize);
    return this.candles.slice(start, this.index);
  }

  getCurrentIndex(): number {
    return this.index;
  }

  getTotalCandles(): number {
    return this.candles.length;
  }
}
