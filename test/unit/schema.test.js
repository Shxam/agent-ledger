import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateEventSchema, PERMITTED_EVENT_TYPES } from '../../src/core/schema.js';
import { ExitCode, LedgerError } from '../../src/core/errors.js';

describe('Event Schema Validator', () => {
  it('accepts valid events for all 9 permitted event types', () => {
    for (const type of PERMITTED_EVENT_TYPES) {
      const payload =
        type === 'tool_requested' || type === 'tool_result_received'
          ? { tool_request_id: 'req_123', tool_name: 'test' }
          : {};

      const event = {
        event_id: `evt_${type}`,
        seq_num: 1,
        run_id: 'run_test',
        branch: 'main',
        type,
        payload,
      };

      assert.doesNotThrow(() => validateEventSchema(event));
    }
  });

  it('rejects unknown event types with ExitCode.VALIDATION_ERROR', () => {
    const invalidEvent = {
      event_id: 'evt_bad',
      seq_num: 1,
      run_id: 'run_test',
      branch: 'main',
      type: 'invalid_event_type',
      payload: {},
    };

    assert.throws(
      () => validateEventSchema(invalidEvent),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.VALIDATION_ERROR
    );
  });

  it('rejects unsupported event type test_completed with ExitCode.VALIDATION_ERROR', () => {
    const invalidEvent = {
      event_id: 'evt_test_completed',
      seq_num: 1,
      run_id: 'run_test',
      branch: 'main',
      type: 'test_completed',
      payload: { passed: 5, failed: 0 },
    };

    assert.throws(
      () => validateEventSchema(invalidEvent),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.VALIDATION_ERROR
    );
  });

  it('rejects missing or invalid event_id', () => {
    assert.throws(
      () => validateEventSchema({ seq_num: 1, run_id: 'r', branch: 'main', type: 'run_started', payload: {} }),
      (err) => err.exitCode === ExitCode.VALIDATION_ERROR
    );
    assert.throws(
      () => validateEventSchema({ event_id: '', seq_num: 1, run_id: 'r', branch: 'main', type: 'run_started', payload: {} }),
      (err) => err.exitCode === ExitCode.VALIDATION_ERROR
    );
  });

  it('rejects seq_num less than 1 or non-integer', () => {
    assert.throws(
      () => validateEventSchema({ event_id: 'e1', seq_num: 0, run_id: 'r', branch: 'main', type: 'run_started', payload: {} }),
      (err) => err.exitCode === ExitCode.VALIDATION_ERROR
    );
    assert.throws(
      () => validateEventSchema({ event_id: 'e1', seq_num: 1.5, run_id: 'r', branch: 'main', type: 'run_started', payload: {} }),
      (err) => err.exitCode === ExitCode.VALIDATION_ERROR
    );
  });

  it('rejects tool events missing tool_request_id', () => {
    assert.throws(
      () => validateEventSchema({
        event_id: 'e1',
        seq_num: 1,
        run_id: 'r',
        branch: 'main',
        type: 'tool_requested',
        payload: { tool_name: 'bash' }, // missing tool_request_id
      }),
      (err) => err.exitCode === ExitCode.VALIDATION_ERROR
    );

    assert.throws(
      () => validateEventSchema({
        event_id: 'e1',
        seq_num: 1,
        run_id: 'r',
        branch: 'main',
        type: 'tool_result_received',
        payload: {}, // missing tool_request_id
      }),
      (err) => err.exitCode === ExitCode.VALIDATION_ERROR
    );
  });
});
