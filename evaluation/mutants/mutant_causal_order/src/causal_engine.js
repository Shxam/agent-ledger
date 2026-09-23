import { ExitCode, LedgerError } from '../../../../src/core/errors.js';

/**
 * MUTANT-CAUSAL-ORDER:
 * In-memory causal engine that matches tool results by array position (FIFO queue)
 * rather than matching by tool_request_id.
 */
export class MutantCausalEngine {
  constructor() {
    this.openQueue = [];
    this.isRunCompleted = false;
  }

  processEvent(event, isHistorical = false) {
    if (this.isRunCompleted) {
      if (isHistorical) {
        throw new LedgerError(ExitCode.TAMPER_DETECTED, 'Log integrity error: Event recorded after run_completed');
      }
      throw new LedgerError(ExitCode.STATE_BLOCKED, 'Error: Cannot append event after run_completed has been logged');
    }

    if (event.type === 'tool_requested') {
      const reqId = event.payload?.tool_request_id;
      // Defect: pushing to a queue and ignoring out-of-order resolution
      this.openQueue.push({ id: reqId, tool_name: event.payload?.tool_name });
    } else if (event.type === 'tool_result_received') {
      if (this.openQueue.length === 0) {
        throw new LedgerError(ExitCode.VALIDATION_ERROR, 'Error: No active tool_requested event found');
      }
      // DEFECT: pops by position rather than looking up by tool_request_id
      const top = this.openQueue.shift();
      if (top.id !== event.payload?.tool_request_id) {
        throw new LedgerError(
          ExitCode.VALIDATION_ERROR,
          `Error: Tool result order mismatch. Expected result for '${top.id}' but received '${event.payload?.tool_request_id}'`
        );
      }
    } else if (event.type === 'run_completed') {
      if (this.openQueue.length > 0) {
        throw new LedgerError(
          ExitCode.STATE_BLOCKED,
          `Error: Cannot complete run with ${this.openQueue.length} active unresolved tool request(s)`
        );
      }
      this.isRunCompleted = true;
    }
  }

  getOpenToolCount() {
    return this.openQueue.length;
  }
}
