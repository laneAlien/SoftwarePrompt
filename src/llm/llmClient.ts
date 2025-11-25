import OpenAI from 'openai';
import { LlmClient, LlmAnalysisInput, LlmAnalysisOutput, LlmMode } from '../core/types';
import { 
  BASE_SYSTEM_PROMPT,
  PAIR_ANALYSIS_SYSTEM_PROMPT,
  POSITION_ANALYSIS_SYSTEM_PROMPT,
  PORTFOLIO_ANALYSIS_SYSTEM_PROMPT,
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
    const selectedKey = apiKey || deepseekKey || openaiKey;
    const baseURL = deepseekKey && !apiKey ? 'https://api.deepseek.com/v1' : undefined;

    this.openai = new OpenAI({
      apiKey: selectedKey,
      baseURL,
    });
    this.model =
      model || (deepseekKey && !apiKey ? process.env.DEEPSEEK_MODEL || 'deepseek-chat' : process.env.LLM_MODEL || 'gpt-3.5-turbo');
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
