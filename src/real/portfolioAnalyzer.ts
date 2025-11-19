import { ExchangeClient } from './exchangeBase';
import { PortfolioSummary, PortfolioAsset, ConcentrationMetrics } from '../core/types';
import { isStablecoin } from '../core/utils';

export async function analyzePortfolio(
  clients: ExchangeClient[]
): Promise<PortfolioSummary> {
  const allAssets: PortfolioAsset[] = [];

  for (const client of clients) {
    try {
      const assets = await client.fetchBalance();
      allAssets.push(...assets);
    } catch (error) {
      console.warn(`Failed to fetch balance from ${client.name}:`, error);
    }
  }

  for (const asset of allAssets) {
    if (!isStablecoin(asset.symbol)) {
      try {
        const client = clients.find((c) => c.name === asset.exchange);
        if (client) {
          const price = await client.getCurrentPrice(`${asset.symbol}/USDT`);
          asset.valueUsd = asset.amount * price;
        }
      } catch (error) {
        asset.valueUsd = 0;
      }
    } else {
      asset.valueUsd = asset.amount;
    }
  }

  const totalValueUsd = allAssets.reduce((sum, asset) => sum + (asset.valueUsd || 0), 0);

  let stablecoinsValueUsd = 0;
  let highRiskValueUsd = 0;

  for (const asset of allAssets) {
    if (isStablecoin(asset.symbol)) {
      stablecoinsValueUsd += asset.valueUsd || 0;
    } else {
      highRiskValueUsd += asset.valueUsd || 0;
    }
  }

  const sortedAssets = [...allAssets].sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));

  const top1Value = sortedAssets[0]?.valueUsd || 0;
  const top3Value = sortedAssets.slice(0, 3).reduce((sum, a) => sum + (a.valueUsd || 0), 0);

  const concentration: ConcentrationMetrics = {
    top1WeightPercent: totalValueUsd > 0 ? (top1Value / totalValueUsd) * 100 : 0,
    top3WeightPercent: totalValueUsd > 0 ? (top3Value / totalValueUsd) * 100 : 0,
    stablecoinsPercent: totalValueUsd > 0 ? (stablecoinsValueUsd / totalValueUsd) * 100 : 0,
    highRiskPercent: totalValueUsd > 0 ? (highRiskValueUsd / totalValueUsd) * 100 : 0,
  };

  return {
    totalValueUsd,
    assets: sortedAssets,
    stablecoinsValueUsd,
    highRiskValueUsd,
    concentration,
  };
}
