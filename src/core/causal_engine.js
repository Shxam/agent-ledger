import { ExitCode, LedgerError } from './errors.js';

/**
 * In-memory state machine for causal validation and run completion enforcement.
 */
export class CausalEngine {
  constructor() {
    /** @type {Map<string, { tool_name?: string, timestamp?: number, seq_num: number }>} */
    this.openToolRequests = new Map();
    this.isRunCompleted = false;
  }

  /**
   * Processes an event and updates causal state.
   *
   * @param {object} event Validated event record
   * @param {boolean} [isHistorical=false] If true, validation errors represent log tampering (ExitCode 5)
   */
  processEvent(event, isHistorical = false) {
    if (this.isRunCompleted) {
      if (isHistorical) {
        throw new LedgerError(
          ExitCode.TAMPER_DETECTED,
          'Log integrity error: Event recorded after run_completed'
        );
      }
      throw new LedgerError(
        ExitCode.STATE_BLOCKED,
        'Error: Cannot append event after run_completed has been logged'
      );
    }

    if (event.type === 'tool_requested') {
      const reqId = event.payload.tool_request_id;
      if (this.openToolRequests.has(reqId)) {
        if (isHistorical) {
          throw new LedgerError(
            ExitCode.TAMPER_DETECTED,
            `Log integrity error: Duplicate active tool_request_id '${reqId}'`
          );
        }
        throw new LedgerError(
          ExitCode.VALIDATION_ERROR,
          `Error: Duplicate active tool_request_id '${reqId}' already in-flight`
        );
      }
      this.openToolRequests.set(reqId, {
        tool_name: event.payload.tool_name,
        timestamp: event.timestamp_ms,
        seq_num: event.seq_num,
      });
    } else if (event.type === 'tool_result_received') {
      const reqId = event.payload.tool_request_id;
      if (!this.openToolRequests.has(reqId)) {
        if (isHistorical) {
          throw new LedgerError(
            ExitCode.TAMPER_DETECTED,
            `Log integrity error: Unmatched tool_result_received for '${reqId}'`
          );
        }
        throw new LedgerError(
          ExitCode.VALIDATION_ERROR,
          `Error: No active tool_requested event found for tool_request_id '${reqId}'`
        );
      }
      this.openToolRequests.delete(reqId);
    } else if (event.type === 'run_completed') {
      if (this.openToolRequests.size > 0) {
        if (isHistorical) {
          throw new LedgerError(
            ExitCode.TAMPER_DETECTED,
            `Log integrity error: run_completed logged with ${this.openToolRequests.size} unresolved tool request(s)`
          );
        }
        throw new LedgerError(
          ExitCode.STATE_BLOCKED,
          `Error: Cannot complete run with ${this.openToolRequests.size} active unresolved tool request(s)`
        );
      }
      this.isRunCompleted = true;
    }
  }

  /**
   * Returns current count of open tool requests.
   * @returns {number}
   */
  getOpenToolCount() {
    return this.openToolRequests.size;
  }
}
