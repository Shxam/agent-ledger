/**
 * Secret Redaction & Safe Credential Inspection Utility
 *
 * Ensures API keys and sensitive tokens never leak into logs, error traces,
 * persistent ledger records, or benchmark evidence files.
 * Uses exclusively EVOLINK_API_KEY for credential access.
 */

/**
 * Returns a redacted version of text or serialized data, replacing sensitive
 * values and token patterns with [REDACTED].
 *
 * @param {any} input
 * @param {string[]} [customSecrets=[]]
 * @returns {any}
 */
export function redactSecrets(input, customSecrets = []) {
  if (input === null || input === undefined) return input;

  if (typeof input === 'object') {
    if (input instanceof Error) {
      input.message = redactSecrets(input.message, customSecrets);
      if (input.stack) {
        input.stack = redactSecrets(input.stack, customSecrets);
      }
      return input;
    }

    if (Array.isArray(input)) {
      return input.map((item) => redactSecrets(item, customSecrets));
    }

    const cleaned = {};
    for (const [key, value] of Object.entries(input)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('key') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('token') ||
        lowerKey.includes('authorization') ||
        lowerKey.includes('auth') ||
        lowerKey.includes('credential')
      ) {
        cleaned[key] = '[REDACTED]';
      } else {
        cleaned[key] = redactSecrets(value, customSecrets);
      }
    }
    return cleaned;
  }

  if (typeof input !== 'string') {
    return input;
  }

  let text = input;

  // 1. Redact known environment secrets if set
  const envSecrets = [
    process.env.EVOLINK_API_KEY,
    process.env.OPENAI_API_KEY,
    ...customSecrets,
  ].filter((s) => typeof s === 'string' && s.trim().length >= 4);

  for (const secret of envSecrets) {
    text = text.replaceAll(secret, '[REDACTED]');
  }

  // 2. Pattern-based redactions
  // Standard API key patterns (sk-...)
  text = text.replace(/sk-[a-zA-Z0-9_\-\*]{10,}/g, '[REDACTED]');
  // Authorization headers
  text = text.replace(/Bearer\s+[a-zA-Z0-9_\-\.\*]{10,}/gi, 'Bearer [REDACTED]');
  text = text.replace(/(?:x-api-key|api-key):\s*[^\r\n,;]+/gi, '$1: [REDACTED]');

  return text;
}

/**
 * Safely inspects whether required credentials are configured
 * without exposing or printing the credential value.
 * - anthropic uses EVOLINK_API_KEY
 * - openai uses OPENAI_API_KEY
 *
 * @param {'anthropic'|'openai'|string} provider
 * @returns {{ provider: string, status: 'configured'|'missing', env_var: string }}
 */
export function checkCredentials(provider) {
  const norm = String(provider).toLowerCase();
  if (norm === 'anthropic') {
    const val = process.env.EVOLINK_API_KEY;
    const isConfigured = typeof val === 'string' && val.trim().length > 0;
    return {
      provider: 'anthropic',
      status: isConfigured ? 'configured' : 'missing',
      env_var: 'EVOLINK_API_KEY',
    };
  }
  if (norm === 'openai') {
    const val = process.env.OPENAI_API_KEY;
    const isConfigured = typeof val === 'string' && val.trim().length > 0;
    return {
      provider: 'openai',
      status: isConfigured ? 'configured' : 'missing',
      env_var: 'OPENAI_API_KEY',
    };
  }
  return {
    provider: norm,
    status: 'missing',
    env_var: 'UNKNOWN',
  };
}
