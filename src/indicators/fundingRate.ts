import ccxt from 'ccxt';

export interface FundingRateResult {
  rate: number;
  symbol: string;
  timestamp: number;
}

export async function fetchFundingRate(
  exchange: ccxt.Exchange,
  symbol: string
): Promise<FundingRateResult | null> {
  if (typeof exchange.fetchFundingRate !== 'function') {
    return null;
  }

  try {
    const result = await exchange.fetchFundingRate(symbol);
    if (!result) return null;
    const rate = Number(result.fundingRate ?? result.info?.fundingRate ?? 0);
    return {
      rate: Number.isFinite(rate) ? rate : 0,
      symbol,
      timestamp: result.timestamp ?? Date.now(),
    };
  } catch (err) {
    return null;
  }
}

export function fundingRiskScore(rate: number): number {
  const abs = Math.abs(rate);
  if (abs < 0.0001) return 0;
  if (abs < 0.001) return 0.25;
  if (abs < 0.005) return 0.5;
  return 0.75;
}

