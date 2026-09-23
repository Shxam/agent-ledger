import { BaseProviderAdapter } from './base.js';

/**
 * Logical Anthropic adapter for claude-opus-5 evaluated via EvoLink.
 */
export class AnthropicAdapter extends BaseProviderAdapter {
  constructor(config = {}) {
    super({
      provider: 'anthropic',
      modelId: config.modelId || 'claude-opus-5',
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      maxOutputBytes: config.maxOutputBytes,
      maxOutputTokens: config.maxOutputTokens,
    });
  }
}
