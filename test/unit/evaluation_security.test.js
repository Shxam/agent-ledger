import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, checkCredentials } from '../../evaluation/security/redact.js';

describe('Evaluation Security & Redaction', () => {
  it('redacts explicit custom secrets from text', () => {
    const raw = 'Connected to service with key secret_token_xyz123abc456 and status OK';
    const redacted = redactSecrets(raw, ['secret_token_xyz123abc456']);
    assert.strictEqual(redacted, 'Connected to service with key [REDACTED] and status OK');
    assert.ok(!redacted.includes('secret_token_xyz123abc456'));
  });

  it('redacts EvoLink and Bearer authorization patterns', () => {
    const sampleKey = 'sk-mockkey1234567890abcdef';
    const sample = `Headers: authorization: Bearer ${sampleKey}, x-api-key: ${sampleKey}`;

    const cleaned = redactSecrets(sample);
    assert.ok(!cleaned.includes(sampleKey));
    assert.ok(cleaned.includes('[REDACTED]'));
  });

  it('redacts sensitive fields in nested JSON objects and arrays', () => {
    const payload = {
      user: 'eval_agent',
      api_key: 'super_secret_value_12345',
      nested: {
        authorization_header: 'Bearer 1234567890abcdef',
        normal_data: 'safe_value',
      },
      list: [{ token: 'abc-xyz-token' }, 'plain text'],
    };

    const sanitized = redactSecrets(payload);
    assert.strictEqual(sanitized.api_key, '[REDACTED]');
    assert.strictEqual(sanitized.nested.authorization_header, '[REDACTED]');
    assert.strictEqual(sanitized.nested.normal_data, 'safe_value');
    assert.strictEqual(sanitized.list[0].token, '[REDACTED]');
    assert.strictEqual(sanitized.list[1], 'plain text');
  });

  it('redacts secrets within Error objects and stack traces while preserving prototype', () => {
    const secret = 'secret_key_to_be_masked_9999';
    const err = new Error(`Connection failed using ${secret}`);
    err.code = 'PROVIDER_ERROR';

    const sanitizedErr = redactSecrets(err, [secret]);
    assert.ok(sanitizedErr instanceof Error);
    assert.ok(!sanitizedErr.message.includes(secret));
    assert.ok(sanitizedErr.message.includes('[REDACTED]'));
    if (sanitizedErr.stack) {
      assert.ok(!sanitizedErr.stack.includes(secret));
    }
    assert.strictEqual(sanitizedErr.code, 'PROVIDER_ERROR');
  });

  it('safely checks credentials without exposing secret values for independent providers', () => {
    const origEvolink = process.env.EVOLINK_API_KEY;
    const origOpenai = process.env.OPENAI_API_KEY;

    try {
      delete process.env.EVOLINK_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const antMissing = checkCredentials('anthropic');
      assert.strictEqual(antMissing.status, 'missing');
      assert.strictEqual(antMissing.env_var, 'EVOLINK_API_KEY');

      const oaiMissing = checkCredentials('openai');
      assert.strictEqual(oaiMissing.status, 'missing');
      assert.strictEqual(oaiMissing.env_var, 'OPENAI_API_KEY');

      process.env.EVOLINK_API_KEY = 'mock_evolink_key_for_test';
      const antConfigured = checkCredentials('anthropic');
      assert.strictEqual(antConfigured.status, 'configured');
      assert.strictEqual(antConfigured.env_var, 'EVOLINK_API_KEY');
      assert.strictEqual(JSON.stringify(antConfigured).includes('mock_evolink_key_for_test'), false);

      process.env.OPENAI_API_KEY = 'mock_openai_key_for_test';
      const oaiConfigured = checkCredentials('openai');
      assert.strictEqual(oaiConfigured.status, 'configured');
      assert.strictEqual(oaiConfigured.env_var, 'OPENAI_API_KEY');
      assert.strictEqual(JSON.stringify(oaiConfigured).includes('mock_openai_key_for_test'), false);
    } finally {
      if (origEvolink !== undefined) process.env.EVOLINK_API_KEY = origEvolink;
      else delete process.env.EVOLINK_API_KEY;
      if (origOpenai !== undefined) process.env.OPENAI_API_KEY = origOpenai;
      else delete process.env.OPENAI_API_KEY;
    }
  });
});
