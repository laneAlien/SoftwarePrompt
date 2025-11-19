import { Position, PositionSide, LeverageRiskResult, RiskLevel } from '../core/types';

export function calcUnrealizedPnl(
  side: PositionSide,
  entryPrice: number,
  currentPrice: number,
  size: number
): number {
  const priceChange = currentPrice - entryPrice;
  return side === 'long' ? priceChange * size : -priceChange * size;
}

export function calcEquity(
  balance: number,
  unrealizedPnl: number,
  initialMargin: number
): number {
  return balance + initialMargin + unrealizedPnl;
}

export function calcMaintenanceMargin(
  notional: number,
  mmr: number
): number {
  return notional * mmr;
}

export function estimateLiquidationPrice(
  side: PositionSide,
  entryPrice: number,
  leverage: number,
  mmr: number
): number | null {
  if (leverage <= 1) {
    return null;
  }

  if (side === 'long') {
    return entryPrice * (1 - 1 / leverage + mmr);
  } else {
    return entryPrice * (1 + 1 / leverage - mmr);
  }
}

export function calcDistanceToLiquidation(
  side: PositionSide,
  currentPrice: number,
  liquidationPrice: number | null
): number | null {
  if (!liquidationPrice) {
    return null;
  }

  if (side === 'long') {
    return ((currentPrice - liquidationPrice) / currentPrice) * 100;
  } else {
    return ((liquidationPrice - currentPrice) / currentPrice) * 100;
  }
}

export function determineRiskLevel(
  distanceToLiqPercent: number | null,
  leverage: number
): RiskLevel {
  if (!distanceToLiqPercent) {
    return 'low';
  }

  if (distanceToLiqPercent < 5 || leverage > 10) {
    return 'extreme';
  } else if (distanceToLiqPercent < 10 || leverage > 5) {
    return 'high';
  } else if (distanceToLiqPercent < 20 || leverage > 3) {
    return 'medium';
  } else {
    return 'low';
  }
}

export function estimateLeverageRiskForPosition(
  position: Position,
  currentPrice: number
): LeverageRiskResult {
  const notional = position.size * currentPrice;
  const initialMargin = notional / position.leverage;
  
  const liquidationPrice = estimateLiquidationPrice(
    position.side,
    position.entryPrice,
    position.leverage,
    0.005
  );

  const distanceToLiqPercent = calcDistanceToLiquidation(
    position.side,
    currentPrice,
    liquidationPrice
  );

  const marginUsagePercent = (initialMargin / position.margin) * 100;

  const riskLevel = determineRiskLevel(distanceToLiqPercent, position.leverage);

  return {
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    currentPrice,
    size: position.size,
    leverage: position.leverage,
    notional,
    initialMargin,
    liquidationPrice,
    distanceToLiqPercent,
    marginUsagePercent,
    riskLevel,
  };
}
