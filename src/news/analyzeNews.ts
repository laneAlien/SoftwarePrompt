import { loadConfig } from '../core/config';
import { OpenAILlmClient } from '../llm/llmClient';
import { NewsItem } from './types';
import { loadRssNews } from './providers/rss';

export interface NewsBrief {
  summary: string;
  riskFlags: string[];
  watch: string[];
}

export interface AnalyzeNewsResult {
  items: NewsItem[];
  llmSummary?: NewsBrief;
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function dedupeAndSort(items: NewsItem[]): NewsItem[] {
  const seen = new Map<string, NewsItem>();

  for (const item of items) {
    const key = normalizeUrl(item.url) || `${item.title}-${item.source}`.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, item);
    }
  }

  return Array.from(seen.values()).sort((a, b) => b.ts - a.ts);
}

export async function analyzeNews(options: {
  symbol?: string;
  configPath?: string;
  useLlm?: boolean;
}): Promise<AnalyzeNewsResult> {
  const config = loadConfig(options.configPath);
  const rssUrls = config.news?.rss ?? [];

  const rssItems = await loadRssNews(rssUrls, options.symbol);
  const items = dedupeAndSort(rssItems);

  let llmSummary: NewsBrief | undefined;
  const wantsLlm = options.useLlm ?? true;
  if (wantsLlm && items.length > 0 && (process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY)) {
    try {
      const llm = new OpenAILlmClient();
      llmSummary = await llm.analyzeNewsBrief(items);
    } catch (error) {
      console.warn('LLM news summary failed:', error);
    }
  }

  return { items, llmSummary };
}
