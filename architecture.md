Architecture Specification: agent-ledger

1. System Topology & Directory Structure

agent-ledger operates entirely on local filesystem primitives. All internal state is isolated within a hidden directory named .agent-ledger/ in the workspace root.

Directory layout:

.agent-ledger/: Root metadata directory.

.agent-ledger/config.json: Workspace configuration, active branch pointer, and engine version.

.agent-ledger/events.ndjson: Canonical append-only newline-delimited JSON event ledger.

.agent-ledger/checkpoints/: Directory storing point-in-time snapshot manifests named <checkpoint_id>.json.

.agent-ledger/branches/: Branch reference files named <branch_name>.json storing head event IDs.

.agent-ledger/registers/: Named register files storing raw payload extracts (reg_<name>.blob).

.agent-ledger/locks/ledger.lock: File descriptor target for POSIX advisory locking (flock).

2. Core Subsystems

2.1 Concurrency & Advisory Lock Arbiter

All CLI invocations mutating or reading .agent-ledger must acquire a POSIX advisory lock via flock(fd, LOCK_EX | LOCK_NB).

If acquisition fails with EWOULDBLOCK or EAGAIN, the command aborts immediately with exit code 3.

The lock file contains an active lease payload:

JSON

{
  "pid": 4812,
  "acquired_at_ms": 1726000000000,
  "ttl_ms": 10000,
  "command": "append"
}


If a lock is held by a dead process (verified via kill(pid, 0) == ESRCH) or if current_time > acquired_at_ms + ttl_ms, the stale lease is unlinked and reclaimed.

2.2 Ingestion & Causal Validation Subsystem

Events are ingested as JSON records. Before any record is written to events.ndjson, the validator checks:

Strict Monotonicity: event.seq_num == previous_event.seq_num + 1.

UUID Uniqueness: event.event_id must not already exist in the event ledger.

Causal Dependency:

If event.type == "tool_result_received", event.payload.tool_request_id must match a prior tool_requested event that has not yet been resolved.

If event.type == "run_completed", the set of open tool requests must be completely empty.

2.3 Cryptographic Hash Chain Engine

Integrity is guaranteed by recursive hashing. Let Ek​ represent the canonical UTF-8 JSON encoding of event k, and let Hk​ represent its cryptographic hash:

H0​=SHA-256("GENESIS")

Hk​=SHA-256(Hk−1​∥canonical_json(Ek​))

Every event persisted in events.ndjson contains this prev_hash field. If any byte of an earlier event is altered, all downstream hashes become invalid, triggering exit code 5.

2.4 Checkpoint & State Reconstruction Subsystem

Checkpoints represent logical state boundaries. A checkpoint manifest stores:

checkpoint_id: Alphanumeric identifier.

event_seq_num: The sequence number of the event at which the checkpoint was taken.

state_vector: Aggregated representation of modified files, completed tests, active tool calls, and plan steps.

Checkpoints cannot be created while a tool call is in-flight.

2.5 Side-Effect Virtualization Subsystem (Replay)

During agent-ledger replay, the engine processes events sequentially from a designated checkpoint.

When encountering a tool_requested event, the engine looks ahead to the matching tool_result_received event in the ledger.

The recorded payload (exit codes, standard output, file changes) is injected directly into the replay state.

The system call or process spawning interface is completely intercepted; no child processes are spawned, and no real disk mutations outside .agent-ledger occur.