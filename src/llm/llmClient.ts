import OpenAI from 'openai';
import { LlmClient, LlmAnalysisInput, LlmAnalysisOutput, LlmMode } from '../core/types';
import { NewsItem } from '../news/types';
import { 
  BASE_SYSTEM_PROMPT,
  PAIR_ANALYSIS_SYSTEM_PROMPT,
  POSITION_ANALYSIS_SYSTEM_PROMPT,
  PORTFOLIO_ANALYSIS_SYSTEM_PROMPT,
  NEWS_BRIEF_SYSTEM_PROMPT,
  NEWS_ANALYSIS_SYSTEM_PROMPT,
  SIMULATION_ANALYSIS_SYSTEM_PROMPT,
  buildUserPromptForMode 
} from './prompts';

export class OpenAILlmClient implements LlmClient {
  private openai: OpenAI;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    // Prefer DeepSeek when its key is available. If an explicit API key is provided and
    // matches the DeepSeek env key, treat it as DeepSeek to ensure the proper base URL/model.
    const useDeepseek = (!!deepseekKey && !apiKey) || (!!apiKey && apiKey === deepseekKey);
    const selectedKey = apiKey || deepseekKey || openaiKey;
    const baseURL = useDeepseek ? 'https://api.deepseek.com/v1' : undefined;

    this.openai = new OpenAI({
      apiKey: selectedKey,
      baseURL,
    });
    if (useDeepseek) {
      this.model = model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    } else {
      const resolvedModel = model || process.env.LLM_MODEL;
      if (!resolvedModel) {
        throw new Error('OpenAI model is not set. Define LLM_MODEL or use --no-llm.');
      }
      this.model = resolvedModel;
    }
  }

  async analyze(input: LlmAnalysisInput, mode: LlmMode): Promise<LlmAnalysisOutput> {
    const systemPrompt = this.getSystemPromptForMode(mode);
    const userPrompt = buildUserPromptForMode(input, mode);

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 1000,
      });

      const content = response.choices[0]?.message?.content || '';
      
      return this.parseResponse(content);
    } catch (error) {
      console.warn('LLM API call failed, using fallback response:', error);
      return this.getFallbackResponse(mode);
    }
  }

  async analyzeNewsBrief(items: NewsItem[]): Promise<{ summary: string; riskFlags: string[]; watch: string[] }> {
    const prompt = this.buildNewsBriefPrompt(items);
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: NEWS_BRIEF_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.5,
      max_tokens: 500,
    });

    const content = response.choices[0]?.message?.content || '';
    return this.parseNewsBrief(content);
  }

  private getSystemPromptForMode(mode: LlmMode): string {
    switch (mode) {
      case 'pair':
        return PAIR_ANALYSIS_SYSTEM_PROMPT;
      case 'position':
        return POSITION_ANALYSIS_SYSTEM_PROMPT;
      case 'portfolio':
        return PORTFOLIO_ANALYSIS_SYSTEM_PROMPT;
      case 'news':
        return NEWS_ANALYSIS_SYSTEM_PROMPT;
      case 'simulation':
        return SIMULATION_ANALYSIS_SYSTEM_PROMPT;
      default:
        return BASE_SYSTEM_PROMPT;
    }
  }

  private buildNewsBriefPrompt(items: NewsItem[]): string {
    const lines = ['Summarize the following news items:'];
    for (const item of items.slice(0, 20)) {
      lines.push(`- ${item.title} (${item.source})`);
      lines.push(`  ${item.summary}`);
    }
    lines.push(
      '\nReturn JSON with fields: summary (string), riskFlags (array of short bullet phrases), watch (array of short bullet phrases). Keep it concise.'
    );
    return lines.join('\n');
  }

  private parseNewsBrief(content: string): { summary: string; riskFlags: string[]; watch: string[] } {
    const parsed = this.safeParseJson(content);
    if (parsed) {
      return {
        summary: typeof parsed.summary === 'string' ? parsed.summary : content.trim(),
        riskFlags: Array.isArray(parsed.riskFlags) ? parsed.riskFlags.filter((item) => typeof item === 'string') : [],
        watch: Array.isArray(parsed.watch) ? parsed.watch.filter((item) => typeof item === 'string') : [],
      };
    }
    return {
      summary: content.trim(),
      riskFlags: [],
      watch: [],
    };
  }

  private safeParseJson(content: string): Record<string, unknown> | null {
    try {
      const trimmed = content.trim();
      if (trimmed.startsWith('{')) {
        return JSON.parse(trimmed) as Record<string, unknown>;
      }
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        const snippet = trimmed.slice(start, end + 1);
        return JSON.parse(snippet) as Record<string, unknown>;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  private parseResponse(content: string): LlmAnalysisOutput {
    return {
      summary: content,
      risks: ['Market volatility', 'Leverage risk', 'Liquidation risk'],
      scenarios: {
        conservative: 'Conservative approach: Monitor position closely and reduce leverage.',
        moderate: 'Moderate approach: Maintain current position with stop-loss protection.',
        aggressive: 'Aggressive approach: Consider scaling position based on technical signals.',
      },
      disclaimer: 'This is analytical information, not financial advice. Trading carries significant risks.',
    };
  }

  private getFallbackResponse(mode: LlmMode): LlmAnalysisOutput {
    return {
      summary: `Unable to generate ${mode} analysis. LLM API not available or API key not configured.`,
      risks: ['LLM analysis unavailable', 'Use manual analysis', 'Verify data independently'],
      scenarios: {
        conservative: 'Proceed with caution without AI insights.',
        moderate: 'Use technical indicators for decision making.',
        aggressive: 'Manual analysis required for aggressive strategies.',
      },
      disclaimer: 'LLM analysis is not available. This is not financial advice.',
    };
  }
}
