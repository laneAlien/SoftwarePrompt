import Parser from 'rss-parser';
import { NewsItem, NewsSentiment } from '../core/types';

const FEEDS = [
  'https://cointelegraph.com/rss',
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
];

const parser = new Parser();

function scoreSentiment(title: string): NewsSentiment {
  const lower = title.toLowerCase();
  if (lower.includes('surge') || lower.includes('rally') || lower.includes('record')) return 'bullish';
  if (lower.includes('hack') || lower.includes('scam') || lower.includes('drop') || lower.includes('lawsuit')) return 'bearish';
  return 'neutral';
}

export async function fetchNews(symbol?: string): Promise<NewsItem[]> {
  const items: NewsItem[] = [];

  for (const feedUrl of FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items || []) {
        const title = item.title || '';
        if (symbol && title.toLowerCase().indexOf(symbol.toLowerCase()) === -1) continue;

        const sentiment = scoreSentiment(title);
        const timestamp = item.isoDate ? Date.parse(item.isoDate) : item.pubDate ? Date.parse(item.pubDate) : Date.now();
        const summary = item.contentSnippet || item.content || title;

        items.push({
          id: item.guid || item.link || `${title}-${timestamp}`,
          title,
          summary: summary || title,
          sentiment,
          source: feed.title || 'RSS',
          type: 'news',
          timestamp,
          rawLink: item.link,
        });
      }
    } catch (err) {
      console.warn('Failed to load RSS feed', feedUrl, err);
    }
  }

  return items;
}
