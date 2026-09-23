import { ExitCode, LedgerError } from './errors.js';

export const PERMITTED_EVENT_TYPES = Object.freeze([
  'run_started',
  'plan_created',
  'tool_requested',
  'tool_result_received',
  'file_changed',
  'test_started',
  'test_finished',
  'checkpoint_created',
  'run_completed',
]);

const PERMITTED_EVENT_TYPES_SET = new Set(PERMITTED_EVENT_TYPES);

/**
 * Validates a candidate event object against structural schema requirements.
 *
 * @param {unknown} event Candidate event object
 * @throws {LedgerError} with ExitCode.VALIDATION_ERROR if invalid
 */
export function validateEventSchema(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new LedgerError(
      ExitCode.VALIDATION_ERROR,
      'Error: Event record must be a valid JSON object'
    );
  }

  // 1. event_id
  if (
    typeof event.event_id !== 'string' ||
    event.event_id.trim().length === 0
  ) {
    throw new LedgerError(
      ExitCode.VALIDATION_ERROR,
      'Error: Event field "event_id" must be a non-empty string'
    );
  }

  // 2. seq_num
  if (
    typeof event.seq_num !== 'number' ||
    !Number.isInteger(event.seq_num) ||
    event.seq_num < 1
  ) {
    throw new LedgerError(
      ExitCode.VALIDATION_ERROR,
      `Error: Event field "seq_num" must be a positive integer >= 1 (got: ${event.seq_num})`
    );
  }

  // 3. run_id
  if (typeof event.run_id !== 'string' || event.run_id.trim().length === 0) {
    throw new LedgerError(
      ExitCode.VALIDATION_ERROR,
      'Error: Event field "run_id" must be a non-empty string'
    );
  }

  // 4. branch
  if (typeof event.branch !== 'string' || event.branch.trim().length === 0) {
    throw new LedgerError(
      ExitCode.VALIDATION_ERROR,
      'Error: Event field "branch" must be a non-empty string'
    );
  }

  // 5. type
  if (
    typeof event.type !== 'string' ||
    !PERMITTED_EVENT_TYPES_SET.has(event.type)
  ) {
    throw new LedgerError(
      ExitCode.VALIDATION_ERROR,
      `Error: Event field "type" '${event.type}' is not a permitted event type`
    );
  }

  // 6. payload
  if (
    !event.payload ||
    typeof event.payload !== 'object' ||
    Array.isArray(event.payload)
  ) {
    throw new LedgerError(
      ExitCode.VALIDATION_ERROR,
      'Error: Event field "payload" must be a JSON object'
    );
  }

  // 7. Type-specific payload validation
  if (event.type === 'tool_requested') {
    if (
      typeof event.payload.tool_request_id !== 'string' ||
      event.payload.tool_request_id.trim().length === 0
    ) {
      throw new LedgerError(
        ExitCode.VALIDATION_ERROR,
        'Error: tool_requested payload must include non-empty "tool_request_id"'
      );
    }
  } else if (event.type === 'tool_result_received') {
    if (
      typeof event.payload.tool_request_id !== 'string' ||
      event.payload.tool_request_id.trim().length === 0
    ) {
      throw new LedgerError(
        ExitCode.VALIDATION_ERROR,
        'Error: tool_result_received payload must include non-empty "tool_request_id"'
      );
    }
  }
}
