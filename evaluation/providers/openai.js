import { BaseProviderAdapter, ConfigurationError, MalformedResponseError } from './base.js';

/**
 * OpenAI Responses API Adapter.
 * Target: gpt-5.6-sol via official OpenAI API (https://api.openai.com/v1/responses)
 */
export class OpenAIAdapter extends BaseProviderAdapter {
  constructor(config = {}) {
    super({
      provider: 'openai',
      modelId: config.modelId || 'gpt-5.6-sol',
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      maxOutputBytes: config.maxOutputBytes,
      maxOutputTokens: config.maxOutputTokens,
    });
  }

  /**
   * Reads exclusively OPENAI_API_KEY from the environment.
   * @returns {string}
   */
  getApiKey() {
    const key = process.env.OPENAI_API_KEY;
    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      throw new ConfigurationError('OPENAI_API_KEY environment variable is missing or empty');
    }
    return key.trim();
  }

  /**
   * Resolves the OpenAI endpoint: POST ${OPENAI_BASE_URL}/responses
   * @returns {string}
   */
  resolveEndpoint() {
    const rawBase = this.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const base = rawBase.replace(/\/+$/, '');
    if (base.endsWith('/responses')) return base;
    if (base.endsWith('/v1')) return `${base}/responses`;
    return `${base}/v1/responses`;
  }

  /**
   * Formats the OpenAI Responses API request.
   * @param {object} request
   * @returns {{ url: string, headers: object, body: string }}
   */
  buildRequest(request) {
    const apiKey = this.getApiKey();
    const url = this.resolveEndpoint();

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };

    const taskText = typeof request.taskText === 'string' ? request.taskText : '';

    const body = JSON.stringify({
      model: this.modelId,
      input: [
        {
          role: 'user',
          content: taskText,
        },
      ],
      max_output_tokens: this.maxOutputTokens,
    });

    return { url, headers, body };
  }

  /**
   * Parses the OpenAI Responses API response.
   * @param {object} data
   * @returns {{ text: string, inputTokens?: number, outputTokens?: number }}
   */
  parseResponse(data) {
    if (!data || typeof data !== 'object') {
      throw new MalformedResponseError('OpenAI response is not an object');
    }

    let text = null;

    // 1. OpenAI Responses API output format: data.output array
    if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item?.type === 'message' && Array.isArray(item.content)) {
          const textBlocks = item.content
            .filter((c) => c && (c.type === 'output_text' || typeof c.text === 'string'))
            .map((c) => (typeof c.text === 'string' ? c.text : (typeof c === 'string' ? c : '')));
          if (textBlocks.length > 0) {
            text = textBlocks.join('\n');
            break;
          }
        } else if (typeof item?.text === 'string') {
          text = item.text;
          break;
        } else if (typeof item?.content === 'string') {
          text = item.content;
          break;
        }
      }
    } else if (typeof data.output_text === 'string') {
      text = data.output_text;
    } else if (Array.isArray(data.choices) && data.choices[0]?.message?.content) {
      // Fallback for chat/responses compatibility
      text = data.choices[0].message.content;
    }

    if (typeof text !== 'string') {
      throw new MalformedResponseError('OpenAI response missing valid output text content');
    }

    if (text.trim().length === 0) {
      throw new MalformedResponseError('OpenAI response returned empty or whitespace-only model content');
    }

    const inputTokens = data.usage?.input_tokens || data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.output_tokens || data.usage?.completion_tokens || 0;

    return { text, inputTokens, outputTokens };
  }
}
