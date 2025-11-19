import { PositionSide } from '../core/types';

export interface SimulatedPosition {
  side: PositionSide;
  entryPrice: number;
  size: number;
  leverage: number;
  mmr: number;
  initialMargin: number;
  isLiquidated: boolean;
  liquidationPrice: number | null;
}

export class OrderExecutionEngine {
  private balanceUsd: number;
  private positions: SimulatedPosition[];

  constructor(initialBalanceUsd: number) {
    this.balanceUsd = initialBalanceUsd;
    this.positions = [];
  }

  openPosition(
    side: PositionSide,
    price: number,
    size: number,
    leverage: number,
    mmr: number
  ): void {
    const notional = size * price;
    const initialMargin = notional / leverage;

    if (initialMargin > this.balanceUsd) {
      throw new Error('Insufficient balance to open position');
    }

    const liquidationPrice = this.calculateLiquidationPrice(
      side,
      price,
      leverage,
      mmr
    );

    this.balanceUsd -= initialMargin;

    this.positions.push({
      side,
      entryPrice: price,
      size,
      leverage,
      mmr,
      initialMargin,
      isLiquidated: false,
      liquidationPrice,
    });
  }

  closePosition(index: number, price: number): void {
    if (index < 0 || index >= this.positions.length) {
      throw new Error('Invalid position index');
    }

    const position = this.positions[index];
    if (position.isLiquidated) {
      throw new Error('Cannot close liquidated position');
    }

    const pnl = this.calculatePnL(position, price);
    this.balanceUsd += position.initialMargin + pnl;

    this.positions.splice(index, 1);
  }

  onPriceUpdate(price: number): void {
    for (let i = this.positions.length - 1; i >= 0; i--) {
      const position = this.positions[i];
      
      if (position.isLiquidated) continue;

      if (this.checkLiquidation(position, price)) {
        position.isLiquidated = true;
      }
    }
  }

  private calculatePnL(position: SimulatedPosition, currentPrice: number): number {
    const priceChange = currentPrice - position.entryPrice;
    const pnl = position.side === 'long'
      ? priceChange * position.size
      : -priceChange * position.size;
    
    return pnl;
  }

  private calculateLiquidationPrice(
    side: PositionSide,
    entryPrice: number,
    leverage: number,
    mmr: number
  ): number | null {
    if (side === 'long') {
      return entryPrice * (1 - 1 / leverage + mmr);
    } else {
      return entryPrice * (1 + 1 / leverage - mmr);
    }
  }

  private checkLiquidation(position: SimulatedPosition, currentPrice: number): boolean {
    if (!position.liquidationPrice) return false;

    if (position.side === 'long') {
      return currentPrice <= position.liquidationPrice;
    } else {
      return currentPrice >= position.liquidationPrice;
    }
  }

  getBalance(): number {
    return this.balanceUsd;
  }

  getPositions(): SimulatedPosition[] {
    return [...this.positions];
  }

  getActivePositions(): SimulatedPosition[] {
    return this.positions.filter((p) => !p.isLiquidated);
  }

  getTotalEquity(currentPrice: number): number {
    let equity = this.balanceUsd;
    
    for (const position of this.positions) {
      if (!position.isLiquidated) {
        const pnl = this.calculatePnL(position, currentPrice);
        equity += position.initialMargin + pnl;
      }
    }

    return equity;
  }
}
