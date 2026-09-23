import { redactSecrets } from '../security/redact.js';

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
    this.code = 'CONFIGURATION_ERROR';
    this.isProviderError = true;
  }
}

export class AuthenticationError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthenticationError';
    this.code = 'AUTHENTICATION_ERROR';
    this.status = status;
    this.isProviderError = true;
  }
}

export class RateLimitError extends Error {
  constructor(message, status = 429) {
    super(message);
    this.name = 'RateLimitError';
    this.code = 'PROVIDER_ERROR';
    this.status = status;
    this.isProviderError = true;
  }
}

export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
    this.code = 'PROVIDER_ERROR';
    this.isProviderError = true;
  }
}

export class ServerError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'ServerError';
    this.code = 'PROVIDER_ERROR';
    this.status = status;
    this.isProviderError = true;
  }
}

export class MalformedResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MalformedResponseError';
    this.code = 'PROVIDER_ERROR';
    this.isProviderError = true;
  }
}

export class OversizedOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OversizedOutputError';
    this.code = 'PROVIDER_ERROR';
    this.isProviderError = true;
  }
}

/**
 * Base abstract class for EvoLink LLM evaluation provider adapters.
 * Both claude-opus-5 and gpt-5.6-sol communicate via EvoLink /chat/completions.
 */
export class BaseProviderAdapter {
  /**
   * @param {object} config
   * @param {string} config.provider Logical label (anthropic or openai)
   * @param {string} config.modelId Exact model ID (claude-opus-5 or gpt-5.6-sol)
   * @param {string} [config.baseUrl]
   * @param {number} [config.timeoutMs=30000]
   * @param {number} [config.maxRetries=2]
   * @param {number} [config.maxOutputBytes=1048576]
   * @param {number} [config.maxOutputTokens=256]
   */
  constructor(config = {}) {
    if (!config || !config.provider) {
      throw new ConfigurationError('Provider name is required for adapter');
    }
    this.provider = config.provider;
    this.modelId = config.modelId;
    this.baseUrl = config.baseUrl || null;
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.maxRetries = config.maxRetries ?? 2;
    this.maxOutputBytes = config.maxOutputBytes ?? 1048576;
    this.maxOutputTokens =
      config.maxOutputTokens ??
      (process.env.MAX_OUTPUT_TOKENS ? Number(process.env.MAX_OUTPUT_TOKENS) : 4096);
  }

  /**
   * Reads exclusively EVOLINK_API_KEY from the environment.
   * @returns {string}
   */
  getApiKey() {
    const key = process.env.EVOLINK_API_KEY;
    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      throw new ConfigurationError('EVOLINK_API_KEY environment variable is missing or empty');
    }
    return key.trim();
  }

  /**
   * Resolves the EvoLink endpoint: POST ${EVOLINK_BASE_URL}/chat/completions
   * @returns {string}
   */
  resolveEndpoint() {
    const rawBase = this.baseUrl || process.env.EVOLINK_BASE_URL || 'https://direct.evolink.ai/v1';
    const base = rawBase.replace(/\/+$/, '');
    if (base.endsWith('/chat/completions')) return base;
    if (base.endsWith('/v1')) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  /**
   * Formats the EvoLink /chat/completions request.
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
      messages: [
        {
          role: 'user',
          content: taskText,
        },
      ],
      max_tokens: this.maxOutputTokens,
      stream: false,
    });

    return { url, headers, body };
  }

  /**
   * Parses the chat completion response.
   * @param {object} data
   * @returns {{ text: string, inputTokens?: number, outputTokens?: number }}
   */
  parseResponse(data) {
    if (!data || typeof data !== 'object') {
      throw new MalformedResponseError('EvoLink response is not an object');
    }

    let text = null;
    if (Array.isArray(data.choices) && data.choices.length > 0 && data.choices[0]) {
      const choice = data.choices[0];
      if (choice.message && typeof choice.message === 'object') {
        const msg = choice.message;
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
            .map((c) => (typeof c.text === 'string' ? c.text : (typeof c === 'string' ? c : '')))
            .join('\n');
        } else if (msg.content && typeof msg.content === 'object' && typeof msg.content.text === 'string') {
          text = msg.content.text;
        }
      } else if (typeof choice.text === 'string') {
        text = choice.text;
      }
    } else if (typeof data.output_text === 'string') {
      text = data.output_text;
    }

    if (typeof text !== 'string') {
      throw new MalformedResponseError('EvoLink response missing valid choice text content');
    }

    if (text.trim().length === 0) {
      throw new MalformedResponseError('EvoLink response returned empty or whitespace-only model content');
    }

    const inputTokens = data.usage?.prompt_tokens || data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || data.usage?.output_tokens || 0;

    return { text, inputTokens, outputTokens };
  }

  /**
   * Executes an EvoLink evaluation request with timeout, retries, and secret masking.
   *
   * @param {object} request
   * @param {string} request.taskText
   * @returns {Promise<{
   *   provider: string,
   *   model_id: string,
   *   content: string,
   *   input_tokens: number,
   *   output_tokens: number,
   *   latency_ms: number,
   *   attempts: number
   * }>}
   */
  async execute(request) {
    // 1. Verify credentials prior to any network call
    const apiKey = this.getApiKey();

    const { url, headers, body } = this.buildRequest(request);

    let attempt = 0;
    const maxAttempts = 1 + Math.max(0, this.maxRetries);
    let lastError = null;
    const startTime = Date.now();

    while (attempt < maxAttempts) {
      attempt++;
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => {
        controller.abort(new TimeoutError(`Request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeoutHandle);

        // Check response size
        const rawText = await response.text();
        const byteLength = Buffer.byteLength(rawText, 'utf8');
        if (byteLength > this.maxOutputBytes) {
          throw new OversizedOutputError(
            `Provider output exceeded max size limit of ${this.maxOutputBytes} bytes (received ${byteLength} bytes)`
          );
        }

        // Handle HTTP errors
        if (!response.ok) {
          const status = response.status;
          let errorMsg = `Provider returned HTTP ${status}`;
          try {
            const errJson = JSON.parse(rawText);
            const msg = errJson.error?.message || errJson.message;
            if (msg) errorMsg += `: ${msg}`;
          } catch {}

          if (status === 401 || status === 403) {
            throw new AuthenticationError(errorMsg, status);
          }

          if (status === 429) {
            const rateErr = new RateLimitError(errorMsg, status);
            if (attempt < maxAttempts) {
              await this._sleep(attempt * 50);
              continue;
            }
            throw rateErr;
          }

          if (status >= 500 && status <= 599) {
            const serverErr = new ServerError(errorMsg, status);
            if (attempt < maxAttempts) {
              await this._sleep(attempt * 50);
              continue;
            }
            throw serverErr;
          }

          // 402 or other 4xx errors
          throw new ServerError(errorMsg, status);
        }

        // Parse valid JSON
        let data;
        try {
          data = JSON.parse(rawText);
        } catch (parseErr) {
          throw new MalformedResponseError(
            `Failed to parse provider response JSON: ${parseErr.message}`
          );
        }

        const parsed = this.parseResponse(data);

        return {
          provider: this.provider,
          model_id: this.modelId,
          content: parsed.text,
          input_tokens: parsed.inputTokens || 0,
          output_tokens: parsed.outputTokens || 0,
          latency_ms: Date.now() - startTime,
          attempts: attempt,
        };
      } catch (err) {
        clearTimeout(timeoutHandle);

        let sanitizedErr = err;
        if (err.name === 'AbortError' || controller.signal.aborted) {
          sanitizedErr = new TimeoutError(`Request timed out after ${this.timeoutMs}ms`);
        } else if (!(err instanceof ConfigurationError || err instanceof AuthenticationError || err.isProviderError)) {
          sanitizedErr = new ServerError(`Network or provider failure: ${err.message}`);
        }

        sanitizedErr = redactSecrets(sanitizedErr, [apiKey]);
        lastError = sanitizedErr;

        // Non-retryable errors abort immediately
        if (
          sanitizedErr instanceof ConfigurationError ||
          sanitizedErr instanceof AuthenticationError ||
          sanitizedErr instanceof MalformedResponseError ||
          sanitizedErr instanceof OversizedOutputError ||
          (sanitizedErr.status && sanitizedErr.status >= 400 && sanitizedErr.status < 429)
        ) {
          throw sanitizedErr;
        }

        // Bounded retries on transient errors (429, 5xx, network)
        if (attempt < maxAttempts) {
          await this._sleep(attempt * 50);
          continue;
        }

        throw sanitizedErr;
      }
    }

    throw redactSecrets(
      lastError || new ServerError('Provider request failed after retries'),
      [apiKey]
    );
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
