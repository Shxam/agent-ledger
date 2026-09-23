import { AnthropicAdapter } from './anthropic.js';
import { OpenAIAdapter } from './openai.js';
import { ConfigurationError } from './base.js';

export {
  BaseProviderAdapter,
  ConfigurationError,
  AuthenticationError,
  RateLimitError,
  TimeoutError,
  ServerError,
  MalformedResponseError,
  OversizedOutputError,
} from './base.js';
export { AnthropicAdapter } from './anthropic.js';
export { OpenAIAdapter } from './openai.js';

/**
 * Creates a provider adapter instance based on configuration.
 *
 * @param {object} config
 * @param {'anthropic'|'openai'|string} config.provider
 * @param {string} [config.modelId]
 * @param {string} [config.baseUrl]
 * @param {number} [config.timeoutMs]
 * @param {number} [config.maxRetries]
 * @param {number} [config.maxOutputBytes]
 * @param {number} [config.maxOutputTokens]
 * @returns {AnthropicAdapter|OpenAIAdapter}
 */
export function createProviderAdapter(config = {}) {
  const provider = String(config.provider || '').toLowerCase();

  switch (provider) {
    case 'anthropic':
      return new AnthropicAdapter(config);
    case 'openai':
      return new OpenAIAdapter(config);
    default:
      throw new ConfigurationError(
        `Unsupported evaluation provider '${config.provider}'. Permitted providers are 'anthropic' and 'openai'.`
      );
  }
}
