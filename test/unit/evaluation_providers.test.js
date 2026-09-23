import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createProviderAdapter,
  AnthropicAdapter,
  OpenAIAdapter,
  ConfigurationError,
  AuthenticationError,
  TimeoutError,
  ServerError,
  MalformedResponseError,
  OversizedOutputError,
} from '../../evaluation/providers/index.js';

describe('Evaluation Provider Adapters (EvoLink /chat/completions Offline Mocks)', () => {
  let server;
  let serverPort;
  let serverBaseUrl;
  let serverRequests = [];
  let serverHandler = null;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const reqInfo = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        };
        serverRequests.push(reqInfo);

        if (serverHandler) {
          serverHandler(reqInfo, res);
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No mock handler configured' }));
        }
      });
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        serverBaseUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    serverRequests = [];
    serverHandler = null;
  });

  it('correctly creates provider adapters via factory', () => {
    const ant = createProviderAdapter({ provider: 'anthropic', modelId: 'claude-opus-5' });
    assert.ok(ant instanceof AnthropicAdapter);
    assert.strictEqual(ant.modelId, 'claude-opus-5');

    const oai = createProviderAdapter({ provider: 'openai', modelId: 'gpt-5.6-sol' });
    assert.ok(oai instanceof OpenAIAdapter);
    assert.strictEqual(oai.modelId, 'gpt-5.6-sol');

    assert.throws(
      () => createProviderAdapter({ provider: 'unsupported_llm' }),
      /Unsupported evaluation provider/
    );
  });

  it('EvoLink: executes claude-opus-5 successfully via POST /chat/completions with Bearer token', async () => {
    const fakeKey = 'mock_evolink_token_claude_123';
    process.env.EVOLINK_API_KEY = fakeKey;

    serverHandler = (req, res) => {
      assert.strictEqual(req.url, '/v1/chat/completions');
      assert.strictEqual(req.headers.authorization, `Bearer ${fakeKey}`);
      assert.strictEqual(req.headers['content-type'], 'application/json');

      const parsed = JSON.parse(req.body);
      assert.strictEqual(parsed.model, 'claude-opus-5');
      assert.strictEqual(parsed.messages[0].role, 'user');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl_mock_001',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Claude Opus 5 generated benchmark plan via EvoLink.',
              },
            },
          ],
          usage: {
            prompt_tokens: 140,
            completion_tokens: 38,
          },
        })
      );
    };

    const adapter = new AnthropicAdapter({
      modelId: 'claude-opus-5',
      baseUrl: `${serverBaseUrl}/v1`,
      timeoutMs: 5000,
      maxRetries: 0,
    });

    const result = await adapter.execute({ taskText: 'Verify agent-ledger benchmark' });
    assert.strictEqual(result.provider, 'anthropic');
    assert.strictEqual(result.model_id, 'claude-opus-5');
    assert.strictEqual(result.content, 'Claude Opus 5 generated benchmark plan via EvoLink.');
    assert.strictEqual(result.input_tokens, 140);
    assert.strictEqual(result.output_tokens, 38);
    assert.strictEqual(result.attempts, 1);
  });

  it('OpenAI: executes gpt-5.6-sol successfully via POST /responses with Bearer token (Responses API)', async () => {
    const fakeKey = 'mock_openai_token_gpt_456';
    process.env.OPENAI_API_KEY = fakeKey;

    serverHandler = (req, res) => {
      assert.strictEqual(req.url, '/v1/responses');
      assert.strictEqual(req.headers.authorization, `Bearer ${fakeKey}`);
      assert.strictEqual(req.headers['content-type'], 'application/json');

      const parsed = JSON.parse(req.body);
      assert.strictEqual(parsed.model, 'gpt-5.6-sol');
      assert.strictEqual(parsed.input[0].role, 'user');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'resp_mock_002',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'GPT-5.6 Sol benchmark execution completed via OpenAI Responses API.',
                },
              ],
            },
          ],
          usage: {
            input_tokens: 185,
            output_tokens: 42,
          },
        })
      );
    };

    const adapter = new OpenAIAdapter({
      modelId: 'gpt-5.6-sol',
      baseUrl: `${serverBaseUrl}/v1`,
      timeoutMs: 5000,
      maxRetries: 0,
    });

    const result = await adapter.execute({ taskText: 'Verify agent-ledger benchmark' });
    assert.strictEqual(result.provider, 'openai');
    assert.strictEqual(result.model_id, 'gpt-5.6-sol');
    assert.strictEqual(result.content, 'GPT-5.6 Sol benchmark execution completed via OpenAI Responses API.');
    assert.strictEqual(result.input_tokens, 185);
    assert.strictEqual(result.output_tokens, 42);
  });

  it('fails fast on missing EVOLINK_API_KEY before sending any network request', async () => {
    delete process.env.EVOLINK_API_KEY;

    const adapter = new AnthropicAdapter({
      baseUrl: serverBaseUrl,
    });

    await assert.rejects(
      async () => {
        await adapter.execute({ taskText: 'test' });
      },
      (err) => {
        assert.ok(err instanceof ConfigurationError);
        assert.strictEqual(err.code, 'CONFIGURATION_ERROR');
        assert.ok(err.message.includes('EVOLINK_API_KEY'));
        return true;
      }
    );

    // Verify ZERO requests were sent to the mock server
    assert.strictEqual(serverRequests.length, 0);
  });

  it('fails fast on missing OPENAI_API_KEY before sending any network request', async () => {
    delete process.env.OPENAI_API_KEY;

    const adapter = new OpenAIAdapter({
      baseUrl: serverBaseUrl,
    });

    await assert.rejects(
      async () => {
        await adapter.execute({ taskText: 'test' });
      },
      (err) => {
        assert.ok(err instanceof ConfigurationError);
        assert.strictEqual(err.code, 'CONFIGURATION_ERROR');
        assert.ok(err.message.includes('OPENAI_API_KEY'));
        return true;
      }
    );

    // Verify ZERO requests were sent to the mock server
    assert.strictEqual(serverRequests.length, 0);
  });

  it('handles provider authentication failure (HTTP 401/403) from EvoLink', async () => {
    process.env.EVOLINK_API_KEY = 'mock_invalid_key';

    serverHandler = (req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid EvoLink API key provided' } }));
    };

    const adapter = new AnthropicAdapter({
      baseUrl: serverBaseUrl,
      maxRetries: 1,
    });

    await assert.rejects(
      async () => {
        await adapter.execute({ taskText: 'test' });
      },
      (err) => {
        assert.ok(err instanceof AuthenticationError);
        assert.strictEqual(err.code, 'AUTHENTICATION_ERROR');
        assert.strictEqual(err.status, 401);
        return true;
      }
    );
  });

  it('handles provider timeout gracefully', async () => {
    process.env.OPENAI_API_KEY = 'mock_token_timeout';

    serverHandler = (req, res) => {
      // Intentionally do not respond in time
      setTimeout(() => {
        res.writeHead(200);
        res.end(JSON.stringify({ choices: [{ message: { content: 'delayed' } }] }));
      }, 500);
    };

    const adapter = new OpenAIAdapter({
      baseUrl: serverBaseUrl,
      timeoutMs: 50,
      maxRetries: 0,
    });

    await assert.rejects(
      async () => {
        await adapter.execute({ taskText: 'test' });
      },
      (err) => {
        assert.ok(err instanceof TimeoutError);
        assert.strictEqual(err.code, 'PROVIDER_ERROR');
        return true;
      }
    );
  });

  it('handles OpenAI authentication failure (HTTP 401/403)', async () => {
    process.env.OPENAI_API_KEY = 'mock_invalid_openai_key';

    serverHandler = (req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
    };

    const adapter = new OpenAIAdapter({
      baseUrl: serverBaseUrl,
      maxRetries: 1,
    });

    await assert.rejects(
      async () => {
        await adapter.execute({ taskText: 'test' });
      },
      (err) => {
        assert.ok(err instanceof AuthenticationError);
        assert.strictEqual(err.code, 'AUTHENTICATION_ERROR');
        assert.strictEqual(err.status, 401);
        return true;
      }
    );
  });

  it('recovers from transient provider failure (HTTP 503 then 200)', async () => {
    process.env.EVOLINK_API_KEY = 'mock_key_retry';

    let requestCount = 0;
    serverHandler = (req, res) => {
      requestCount++;
      if (requestCount === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'EvoLink upstream temporarily unavailable' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: 'Recovered from transient error.' } }],
          })
        );
      }
    };

    const adapter = new AnthropicAdapter({
      baseUrl: serverBaseUrl,
      maxRetries: 2,
    });

    const res = await adapter.execute({ taskText: 'test' });
    assert.strictEqual(res.content, 'Recovered from transient error.');
    assert.strictEqual(res.attempts, 2);
    assert.strictEqual(requestCount, 2);
  });

  it('fails with MalformedResponseError when response is invalid JSON', async () => {
    process.env.OPENAI_API_KEY = 'mock_key_json_err';

    serverHandler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('<html><head><title>Bad Gateway</title></head><body>502</body></html>');
    };

    const adapter = new OpenAIAdapter({
      baseUrl: serverBaseUrl,
      maxRetries: 0,
    });

    await assert.rejects(
      async () => {
        await adapter.execute({ taskText: 'test' });
      },
      (err) => {
        assert.ok(err instanceof MalformedResponseError);
        assert.strictEqual(err.code, 'PROVIDER_ERROR');
        return true;
      }
    );
  });

  it('enforces max_output_bytes limit and throws OversizedOutputError', async () => {
    process.env.EVOLINK_API_KEY = 'mock_key_oversize';

    serverHandler = (req, res) => {
      const hugeText = 'B'.repeat(5000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: hugeText } }] }));
    };

    const adapter = new AnthropicAdapter({
      baseUrl: serverBaseUrl,
      maxOutputBytes: 1000,
      maxRetries: 0,
    });

    await assert.rejects(
      async () => {
        await adapter.execute({ taskText: 'test' });
      },
      (err) => {
        assert.ok(err instanceof OversizedOutputError);
        assert.strictEqual(err.code, 'PROVIDER_ERROR');
        assert.ok(err.message.includes('max size limit'));
        return true;
      }
    );
  });

  it('exhausts retries on persistent server failure (HTTP 500)', async () => {
    process.env.OPENAI_API_KEY = 'mock_key_server_err';

    let calls = 0;
    serverHandler = (req, res) => {
      calls++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Gateway Error' }));
    };

    const adapter = new OpenAIAdapter({
      baseUrl: serverBaseUrl,
      maxRetries: 2,
    });

    await assert.rejects(
      async () => {
        await adapter.execute({ taskText: 'test' });
      },
      (err) => {
        assert.ok(err instanceof ServerError);
        assert.strictEqual(err.code, 'PROVIDER_ERROR');
        assert.strictEqual(calls, 3);
        return true;
      }
    );
  });

  it('guarantees secret redaction in error traces and messages', async () => {
    const sensitiveKey = 'mock_secret_to_redact_99999';
    process.env.EVOLINK_API_KEY = sensitiveKey;

    serverHandler = (req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Rejected key: ${sensitiveKey}` } }));
    };

    const adapter = new AnthropicAdapter({
      baseUrl: serverBaseUrl,
      maxRetries: 0,
    });

    await assert.rejects(
      async () => {
        await adapter.execute({ taskText: 'test' });
      },
      (err) => {
        assert.ok(!err.message.includes(sensitiveKey));
        assert.ok(err.message.includes('[REDACTED]'));
        if (err.stack) {
          assert.ok(!err.stack.includes(sensitiveKey));
        }
        return true;
      }
    );
  });
});
