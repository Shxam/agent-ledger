Technical Design Document: agent-ledger

1. Data Schemas

1.1 Event NDJSON Record Schema

Each line in .agent-ledger/events.ndjson is a single-line JSON object adhering to the following structure:

JSON

{
  "event_id": "evt_01HXYZ1234567890",
  "seq_num": 42,
  "run_id": "run_coding_agent_alpha",
  "branch": "main",
  "type": "tool_result_received",
  "prev_hash": "a8f5c2d3e4b5a6c7d8e9f0123456789abcdef0123456789abcdef0123456789a",
  "timestamp_ms": 1726000005120,
  "payload": {
    "tool_request_id": "req_01HXYZ1230000000",
    "tool_name": "shell.execute",
    "exit_code": 0,
    "stdout": "Build passed: 12 tests succeeded\n",
    "stderr": ""
  }
}


Permitted event types:

run_started

plan_created

tool_requested

tool_result_received

file_changed

test_started

test_finished

checkpoint_created

run_completed

1.2 Checkpoint Manifest Schema (checkpoints/<checkpoint_id>.json)

JSON

{
  "checkpoint_id": "chk_step_04",
  "run_id": "run_coding_agent_alpha",
  "branch": "main",
  "seq_num": 42,
  "last_event_id": "evt_01HXYZ1234567890",
  "state_snapshot": {
    "agent_phase": "RUNNING_TESTS",
    "active_tool_calls": [],
    "modified_files": {
      "src/core.py": "4f8d3a12..."
    },
    "test_summary": {
      "passed": 12,
      "failed": 0
    }
  }
}


2. Invariant Enforcement & State Transitions

2.1 Causal Validation State Machine

The state reconstructor maintains an in-memory verification vector:

open_tool_requests: Hash map tracking tool_request_id -> {tool_name, timestamp}.

When tool_requested is parsed, insert into open_tool_requests. If tool_request_id already exists, throw CAUSAL_VALIDATION_ERROR (Exit 2).

When tool_result_received is parsed, search open_tool_requests. If not found, throw CAUSAL_VALIDATION_ERROR (Exit 2). If found, delete entry.

When run_completed is parsed, assert len(open_tool_requests) == 0. If non-empty, throw INCOMPLETE_STATE_BLOCKED (Exit 4).

2.2 Atomic Checkpoint Creation

To prevent corrupt checkpoint manifests during a SIGKILL:

Serialize manifest to .agent-ledger/checkpoints/<checkpoint_id>.tmp.

Issue an explicit fsync() on the temporary file descriptor.

Invoke POSIX rename(2) to atomically move the temporary file to .agent-ledger/checkpoints/<checkpoint_id>.json.

Issue an fsync() on the .agent-ledger/checkpoints/ directory descriptor.

2.3 Crash Recovery Algorithm (agent-ledger recover)

When recover is called following an unannounced crash:

Open events.ndjson with read/write binary permissions.

Scan line-by-line from byte offset 0.

For each line, attempt JSON decoding.

If a line fails JSON decoding or lacks a trailing newline character \n:

Determine the byte offset where the last valid line ended.

Call ftruncate(fd, last_valid_offset).

Log warning to standard error indicating torn line truncation.

Verify cryptographic hash chain H0​…Hk​ across all remaining valid lines.

If any intermediate hash does not match, return exit code 7 (UNRECOVERABLE_CORRUPTION).

Identify the most recent valid checkpoint_created record.

Unlink any stale lock file in .agent-ledger/locks/.

Exit with code 0.

3. Verifier Mutants and Test Mapping

Mutant Identifier

Subsystem

Targeted Verification Check

Failure Logic Injected

MUTANT-CAUSAL-ORDER

Causal Engine

CHECK-SCHEMA-001

Matches tool results to requests by array position rather than matching tool_request_id.

MUTANT-TAIL-CRASH

Recovery Subsystem

CHECK-CRASH-001

Uses json.load() on the entire file, crashing with unhandled exception on torn trailing lines.

MUTANT-LIVE-REPLAY

Replay Engine

CHECK-REPLAY-001

Executes real shell subprocess calls during replay mode rather than returning recorded fixtures.

MUTANT-DRIFT-BLIND

Hash Chain Engine

CHECK-DRIFT-001

Reads events without recalculating or verifying the SHA-256 prev_hash chain.

MUTANT-BRANCH-OVERWRITE

Branching Subsystem

CHECK-BRANCH-001

Directly mutates the main event log when creating a branch rather than isolating the branch DAG.

MUTANT-LOCK-OMISSION

Concurrency Arbiter

CHECK-LOCK-001

Omits POSIX flock, permitting concurrent append processes to interleave partial lines.