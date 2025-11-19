import { NewsItem } from '../core/types';

export async function aggregateNews(symbol?: string): Promise<NewsItem[]> {
  const news: NewsItem[] = [
    {
      id: '1',
      symbol: 'TON',
      source: 'CryptoNews',
      type: 'news',
      sentiment: 'bullish',
      timestamp: Date.now() - 3600000,
      title: 'TON Network Ecosystem Expansion',
      summary: 'TON ecosystem continues to grow with new DeFi projects and integrations.',
      rawLink: 'https://example.com/ton-news-1',
    },
    {
      id: '2',
      symbol: 'TON',
      source: 'Market Analysis',
      type: 'signal',
      sentiment: 'neutral',
      timestamp: Date.now() - 7200000,
      title: 'TON Technical Analysis',
      summary: 'TON price consolidating in key support zone, awaiting breakout direction.',
    },
    {
      id: '3',
      symbol: 'BTC',
      source: 'Bloomberg Crypto',
      type: 'news',
      sentiment: 'bullish',
      timestamp: Date.now() - 1800000,
      title: 'Bitcoin Institutional Adoption Grows',
      summary: 'Major financial institutions continue to add Bitcoin to their portfolios.',
    },
  ];

  if (symbol) {
    const normalizedSymbol = symbol.toUpperCase().replace('USDT', '').replace('USD', '');
    return news.filter((item) => 
      item.symbol?.toUpperCase().includes(normalizedSymbol)
    );
  }

  return news;
}
