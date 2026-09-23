import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CausalEngine } from '../../src/core/causal_engine.js';
import { ExitCode, LedgerError } from '../../src/core/errors.js';

describe('Run Completion Rules', () => {
  it('blocks run_completed when unresolved tool calls remain in-flight (ExitCode 4)', () => {
    const engine = new CausalEngine();

    engine.processEvent({
      event_id: 'e1',
      seq_num: 1,
      type: 'tool_requested',
      payload: { tool_request_id: 'req_pending' },
    });

    assert.throws(
      () => engine.processEvent({
        event_id: 'e2',
        seq_num: 2,
        type: 'run_completed',
        payload: {},
      }),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.STATE_BLOCKED
    );
  });

  it('allows run_completed when all tool calls are resolved', () => {
    const engine = new CausalEngine();

    engine.processEvent({
      event_id: 'e1',
      seq_num: 1,
      type: 'tool_requested',
      payload: { tool_request_id: 'req_1' },
    });
    engine.processEvent({
      event_id: 'e2',
      seq_num: 2,
      type: 'tool_result_received',
      payload: { tool_request_id: 'req_1' },
    });

    assert.doesNotThrow(() => {
      engine.processEvent({
        event_id: 'e3',
        seq_num: 3,
        type: 'run_completed',
        payload: {},
      });
    });

    assert.ok(engine.isRunCompleted);
  });

  it('blocks any subsequent event after run_completed is logged (ExitCode 4)', () => {
    const engine = new CausalEngine();

    engine.processEvent({
      event_id: 'e1',
      seq_num: 1,
      type: 'run_completed',
      payload: {},
    });

    assert.throws(
      () => engine.processEvent({
        event_id: 'e2',
        seq_num: 2,
        type: 'plan_created',
        payload: {},
      }),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.STATE_BLOCKED
    );
  });
});
