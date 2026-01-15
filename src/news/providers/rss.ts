import Parser from 'rss-parser';
import { NewsItem } from '../types';

const parser = new Parser();

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function matchesSymbol(text: string, symbol?: string): boolean {
  if (!symbol) return true;
  return text.toLowerCase().includes(symbol.toLowerCase());
}

export async function loadRssNews(urls: string[], symbol?: string): Promise<NewsItem[]> {
  if (!urls.length) return [];
  const items: NewsItem[] = [];

  await Promise.all(
    urls.map(async (feedUrl) => {
      try {
        const feed = await parser.parseURL(feedUrl);
        const source = feed.title || feedUrl;

        for (const entry of feed.items || []) {
          const title = normalizeText(entry.title || '');
          const summary = normalizeText(entry.contentSnippet || entry.content || title);
          const url = entry.link || entry.guid || '';
          if (!title || !url) continue;

          const timestamp = entry.isoDate
            ? Date.parse(entry.isoDate)
            : entry.pubDate
            ? Date.parse(entry.pubDate)
            : Date.now();
          const matches = matchesSymbol(`${title} ${summary}`, symbol);
          if (!matches) continue;

          items.push({
            title,
            summary: summary || title,
            url,
            source,
            ts: Number.isNaN(timestamp) ? Date.now() : timestamp,
            symbols: symbol ? [symbol] : undefined,
          });
        }
      } catch (error) {
        console.warn('Failed to load RSS feed', feedUrl, error);
      }
    })
  );

  return items;
}
