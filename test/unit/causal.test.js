import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CausalEngine } from '../../src/core/causal_engine.js';
import { ExitCode, LedgerError } from '../../src/core/errors.js';

describe('Causal Validation State Machine', () => {
  it('correctly tracks sequential tool requests and results', () => {
    const engine = new CausalEngine();

    const reqA = {
      event_id: 'e1',
      seq_num: 1,
      type: 'tool_requested',
      payload: { tool_request_id: 'req_A', tool_name: 'shell' },
    };
    engine.processEvent(reqA);
    assert.equal(engine.getOpenToolCount(), 1);

    const resA = {
      event_id: 'e2',
      seq_num: 2,
      type: 'tool_result_received',
      payload: { tool_request_id: 'req_A', exit_code: 0 },
    };
    engine.processEvent(resA);
    assert.equal(engine.getOpenToolCount(), 0);
  });

  it('correctly tracks interleaved/nested tool requests and results by ID', () => {
    const engine = new CausalEngine();

    engine.processEvent({
      event_id: 'e1',
      seq_num: 1,
      type: 'tool_requested',
      payload: { tool_request_id: 'req_A' },
    });
    engine.processEvent({
      event_id: 'e2',
      seq_num: 2,
      type: 'tool_requested',
      payload: { tool_request_id: 'req_B' },
    });
    assert.equal(engine.getOpenToolCount(), 2);

    // Resolve B first
    engine.processEvent({
      event_id: 'e3',
      seq_num: 3,
      type: 'tool_result_received',
      payload: { tool_request_id: 'req_B' },
    });
    assert.equal(engine.getOpenToolCount(), 1);

    // Resolve A second
    engine.processEvent({
      event_id: 'e4',
      seq_num: 4,
      type: 'tool_result_received',
      payload: { tool_request_id: 'req_A' },
    });
    assert.equal(engine.getOpenToolCount(), 0);
  });

  it('rejects unmatched tool_result_received with ExitCode.VALIDATION_ERROR', () => {
    const engine = new CausalEngine();

    assert.throws(
      () => engine.processEvent({
        event_id: 'e1',
        seq_num: 1,
        type: 'tool_result_received',
        payload: { tool_request_id: 'req_orphan' },
      }),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.VALIDATION_ERROR
    );
  });

  it('rejects duplicate active tool_request_id with ExitCode.VALIDATION_ERROR', () => {
    const engine = new CausalEngine();

    engine.processEvent({
      event_id: 'e1',
      seq_num: 1,
      type: 'tool_requested',
      payload: { tool_request_id: 'req_duplicate' },
    });

    assert.throws(
      () => engine.processEvent({
        event_id: 'e2',
        seq_num: 2,
        type: 'tool_requested',
        payload: { tool_request_id: 'req_duplicate' },
      }),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.VALIDATION_ERROR
    );
  });
});
