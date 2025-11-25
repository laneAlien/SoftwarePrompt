import { NewsItem } from '../core/types';
import { fetchNews } from './newsFetcher';

/**
 * Aggregates news from RSS and API sources. Placeholder for future Telegram/API enrichment.
 */
export async function aggregateNews(symbol?: string): Promise<NewsItem[]> {
  const baseNews = await fetchNews(symbol);
  // TODO: integrate CoinMarketCal / Binance Announcements / Telegram channels
  return baseNews;
}
