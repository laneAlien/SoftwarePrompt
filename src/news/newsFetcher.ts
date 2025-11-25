import Parser from 'rss-parser';

export interface NewsItem {
  title: string;
  link: string;
  pubDate?: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  source?: string;
}

const FEEDS = [
  'https://cointelegraph.com/rss',
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
];

const parser = new Parser();

function scoreSentiment(title: string): 'bullish' | 'bearish' | 'neutral' {
  const lower = title.toLowerCase();
  if (lower.includes('surge') || lower.includes('rally') || lower.includes('record')) return 'bullish';
  if (lower.includes('hack') || lower.includes('scam') || lower.includes('drop') || lower.includes('lawsuit'))
    return 'bearish';
  return 'neutral';
}

export async function fetchNews(symbol?: string): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  for (const feedUrl of FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items || []) {
        const title = item.title || '';
        if (symbol && title.toLowerCase().indexOf(symbol.toLowerCase()) === -1) {
          continue;
        }
        items.push({
          title,
          link: item.link || '',
          pubDate: item.pubDate,
          sentiment: scoreSentiment(title),
          source: feed.title,
        });
      }
    } catch (err) {
      console.warn('Failed to load RSS feed', feedUrl, err);
    }
  }

  return items;
}

