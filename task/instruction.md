ask Instruction: Autonomous Agent Execution Ledger (agent-ledger)

Problem Overview

Construct a command-line utility named agent-ledger that records, validates, checkpoints, and replays tool-using AI agent executions using an immutable, crash-resilient event log.

The compiled executable must be named agent-ledger and must reside on the system execution PATH after running your build script.

Core Storage Layout

All persistent engine data must reside inside a .agent-ledger/ directory located in the working directory:

.agent-ledger/events.ndjson: Append-only newline-delimited JSON event log.

.agent-ledger/checkpoints/: Stored checkpoint snapshot manifests (<checkpoint_id>.json).

.agent-ledger/branches/: Branch state and head tracking files.

.agent-ledger/registers/: Named register storage (reg_<name>.blob).

.agent-ledger/locks/ledger.lock: File used for POSIX advisory locking.

Command-Line Interface Specification

1. agent-ledger init [run_id]

Initializes a new execution ledger in .agent-ledger/.

Writes the initial configuration and sets the active branch to main.

Exit 0: Initialized successfully.

Exit 1: Repository already initialized.

2. agent-ledger append <event_json_path>

Appends a single JSON event to the active branch in events.ndjson.

Acquires a non-blocking POSIX advisory lock (flock) on .agent-ledger/locks/ledger.lock.

Validates that seq_num is strictly equal to the preceding seq_num + 1.

Rejects duplicate event_id entries.

Enforces causal rules: tool_result_received must reference a valid, open tool_request_id.

Computes the cryptographic hash chain using SHA-256 over the previous hash and canonical event JSON:

Hk​=SHA-256(Hk−1​∥canonical_json(Ek​))

Exit 0: Event appended successfully.

Exit 2: Schema or causal validation error (e.g., sequence error, unmatched tool result).

Exit 3: POSIX lock contention (another process holds the lock).

Exit 4: Attempted to append after a run_completed event was logged.

Exit 5: Hash chain drift detected (historical log tampered with out-of-band).

3. agent-ledger checkpoint --id <checkpoint_id>

Creates an immutable checkpoint representing the state of the agent at the current event position.

Captures modified files, test summaries, and current plan state into .agent-ledger/checkpoints/<checkpoint_id>.json.

Writes must be atomic (write to temporary file, fsync, and rename).

A checkpoint cannot be taken while an unresolved tool call is active.

Exit 0: Checkpoint created.

Exit 4: Active in-flight tool call detected; checkpoint blocked.

Exit 6: Checkpoint ID already exists.

4. agent-ledger status [--json]

Emits the current status: active run ID, current branch, total event count, last checkpoint ID, and open tool calls.

Exit 0: Success.

5. agent-ledger branch --from <checkpoint_id> --name <branch_name>

Forks a new speculative execution branch from an existing checkpoint.

Future appends to this branch must not overwrite or corrupt the parent event history.

Exit 0: Branch created.

Exit 6: Branch name already exists or checkpoint ID not found.

6. agent-ledger replay --from <checkpoint_id> [--step <count>]

Reconstructs and replays the agent's logical state from the specified checkpoint.

All tool side effects (shell commands, network calls, file writes) must be virtualized and satisfied directly from recorded ledger outputs. No real shell processes or external file writes outside .agent-ledger/ may be executed.

If --step <count> is supplied, executes exactly that number of steps forward.

Exit 0: Replay completed cleanly.

Exit 1: Checkpoint ID not found.

7. agent-ledger recover

Executes crash recovery following an abnormal termination (SIGKILL).

Scans events.ndjson and detects torn or partially written lines at the tail.

Truncates the damaged trailing bytes while preserving all preceding valid JSON records.

Validates the cryptographic hash chain of all preserved records.

Releases stale advisory locks.

Exit 0: Recovery succeeded.

Exit 7: Unrecoverable log corruption detected prior to the last valid checkpoint.

8. agent-ledger register-put --reg <name> <file_path>

Copies the contents of <file_path> into named scratch register .agent-ledger/registers/reg_<name>.blob.

<name> is a single alphanumeric character (e.g., a, b, 1).

Exit 0: Register updated.

Exit 1: Source file missing or invalid register identifier.

9. agent-ledger register-get --reg <name>

Streams the raw content of the named register directly to stdout.

Exit 0: Success.

Exit 1: Register does not exist or is empty.

10. agent-ledger export --format json

Outputs the entire reconstructed run execution trace to standard output with canonically sorted JSON keys.

Exit 0: Success.

Exit 5: Log tampering detected during export traversal.