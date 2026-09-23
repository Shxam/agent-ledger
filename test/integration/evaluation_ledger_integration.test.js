import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { runModelEvaluation } from '../../evaluation/runner/model_runner.js';
import { createEvaluationRequest } from '../../evaluation/contracts/request.js';
import { createTempWorkspace, cleanTempWorkspace, runCli } from '../../evaluation/verifier/runner.js';
import { PERMITTED_EVENT_TYPES } from '../../src/core/schema.js';

describe('Integration: Model Evaluation & Ledger Auditing (Mocked Offline)', () => {
  let server;
  let serverPort;
  let serverBaseUrl;
  let serverHandler = null;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        if (serverHandler) {
          serverHandler({ method: req.method, url: req.url, body }, res);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: 'Evaluation successful.' } }],
            })
          );
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

  it('records successful model evaluation into agent-ledger using strictly 9 permitted event types', async () => {
    process.env.EVOLINK_API_KEY = 'mock_evolink_key_for_ledger_test';

    serverHandler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl_test_001',
          object: 'chat.completion',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Model generated solution verified.',
              },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 35 },
        })
      );
    };

    const workspace = createTempWorkspace('eval-ledger-test');

    const request = createEvaluationRequest({
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      taskText: 'Autonomous ledger evaluation instruction',
      repetition: 1,
    });
    request.baseUrl = `${serverBaseUrl}/v1`;

    const result = await runModelEvaluation(request, {
      workspaceDir: workspace,
      keepWorkspace: true,
    });

    try {
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.classification, 'PASS');
      assert.strictEqual(result.ledger_verified, true);
      assert.ok(result.prompt_hash);
      assert.ok(result.response_hash);

      // Inspect .agent-ledger/events.ndjson
      const eventsFile = path.join(workspace, '.agent-ledger', 'events.ndjson');
      assert.ok(fs.existsSync(eventsFile));

      const lines = fs
        .readFileSync(eventsFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0);

      assert.strictEqual(lines.length, 5);

      const parsedEvents = lines.map((l) => JSON.parse(l));

      // Verify sequence monotonicity
      parsedEvents.forEach((evt, idx) => {
        assert.strictEqual(evt.seq_num, idx + 1);
        assert.ok(PERMITTED_EVENT_TYPES.includes(evt.type), `Event type ${evt.type} must be permitted`);
      });

      assert.strictEqual(parsedEvents[0].type, 'run_started');
      assert.strictEqual(parsedEvents[1].type, 'plan_created');
      assert.strictEqual(parsedEvents[2].type, 'tool_requested');
      assert.strictEqual(parsedEvents[3].type, 'tool_result_received');
      assert.strictEqual(parsedEvents[4].type, 'run_completed');

      // Verify zero secret leakage in ledger events
      const rawLedgerContent = fs.readFileSync(eventsFile, 'utf8');
      assert.ok(!rawLedgerContent.includes('mock_evolink_key_for_ledger_test'));

      // Verify status and export via CLI
      const binPath = path.resolve('bin/agent-ledger');
      const statusRes = await runCli(binPath, ['status', '--json'], { cwd: workspace });
      assert.strictEqual(statusRes.exitCode, 0);

      const exportRes = await runCli(binPath, ['export', '--format', 'json'], { cwd: workspace });
      assert.strictEqual(exportRes.exitCode, 0);
    } finally {
      cleanTempWorkspace(workspace);
    }
  });

  it('records provider failure without confusing it with benchmark success', async () => {
    process.env.EVOLINK_API_KEY = 'mock_evolink_key_failure_test';

    serverHandler = (req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'EvoLink internal error' } }));
    };

    const workspace = createTempWorkspace('eval-ledger-fail-test');

    const request = createEvaluationRequest({
      provider: 'openai',
      modelId: 'gpt-5.6-sol',
      taskText: 'Autonomous ledger evaluation instruction',
      repetition: 1,
      limits: { max_retries: 0 },
    });
    request.baseUrl = `${serverBaseUrl}/v1`;

    const result = await runModelEvaluation(request, {
      workspaceDir: workspace,
      keepWorkspace: true,
    });

    try {
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.classification, 'PROVIDER_ERROR');
      assert.strictEqual(result.ledger_verified, true);

      // Ledger still has valid structure and sealing
      const eventsFile = path.join(workspace, '.agent-ledger', 'events.ndjson');
      const lines = fs
        .readFileSync(eventsFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0);

      assert.strictEqual(lines.length, 5);
      const parsedEvents = lines.map((l) => JSON.parse(l));

      assert.strictEqual(parsedEvents[3].type, 'tool_result_received');
      assert.strictEqual(parsedEvents[3].payload.status, 'error');

      assert.strictEqual(parsedEvents[4].type, 'run_completed');
      assert.strictEqual(parsedEvents[4].payload.status, 'failed');
    } finally {
      cleanTempWorkspace(workspace);
    }
  });
});
