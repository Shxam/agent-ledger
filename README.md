# agent-ledger

[![Node.js](https://img.shields.io/badge/Node.js-v20%2B-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-153%20passed-success.svg)]()
[![Verification](https://img.shields.io/badge/verifier-6%2F6%20passed-success.svg)]()
[![Mutant Kill Rate](https://img.shields.io/badge/mutants-100%25%20killed-success.svg)]()

> **Deterministic, crash-resilient, cryptographic execution ledger and replay engine for tool-calling autonomous AI agents.**

---

## Table of Contents

- [Overview](#overview)
- [Architecture & Design Principles](#architecture--design-principles)
  - [1. Cryptographic Tamper-Evidence](#1-cryptographic-tamper-evidence)
  - [2. Causal Event State Machine](#2-causal-event-state-machine)
  - [3. POSIX Advisory Locking (`flock`)](#3-posix-advisory-locking-flock)
  - [4. Speculative Execution & Branch DAG](#4-speculative-execution--branch-dag)
  - [5. Atomic Checkpointing & State Reconstruction](#5-atomic-checkpointing--state-reconstruction)
  - [6. Descriptor-Level Crash Recovery](#6-descriptor-level-crash-recovery)
  - [7. Named Scratch Registers](#7-named-scratch-registers)
- [CLI Reference](#cli-reference)
  - [`init`](#1-init)
  - [`append`](#2-append)
  - [`checkpoint`](#3-checkpoint)
  - [`branch`](#4-branch)
  - [`replay`](#5-replay)
  - [`recover`](#6-recover)
  - [`register-put` & `register-get`](#7-register-put--register-get)
  - [`status`](#8-status)
  - [`export`](#9-export)
- [Exit Codes](#exit-codes)
- [LLM Evaluation Harness](#llm-evaluation-harness)
  - [Dual Provider Routing](#dual-provider-routing)
  - [Response Validation & Secret Redaction](#response-validation--secret-redaction)
- [Verification & Benchmark Results](#verification--benchmark-results)
  - [Unit & Integration Test Suite](#unit--integration-test-suite)
  - [Private Reference Verifier](#private-reference-verifier)
  - [Mutant Benchmark Suite](#mutant-benchmark-suite)
  - [Live Evaluation Summary](#live-evaluation-summary)
- [Quickstart & Verification Commands](#quickstart--verification-commands)

---

## Overview

Modern autonomous agents execute complex, multi-step actions across tools, filesystems, and APIs. When agents fail, diverge, or crash, developers face critical gaps: untracked side-effects, incomplete execution traces, and non-deterministic behavior.

`agent-ledger` provides an **append-only, cryptographic execution ledger** and **virtualized deterministic replay engine**. It guarantees:
* **Tamper Evidence**: Every event is chained via SHA-256 digests over canonical JSON payloads.
* **Causal Consistency**: Tool requests and tool results are causally paired; runs cannot complete or checkpoint with unresolved tool invocations.
* **Concurrency Safety**: POSIX advisory locking (`flock`) prevents multi-agent log corruption and race conditions.
* **Zero-Side-Effect Replay**: Reconstructs state snapshots and virtualizes tool outputs without re-executing external commands or modifying live environments.
* **Crash Resilience**: Abrupt process terminations (e.g., `SIGKILL`, system panic) with torn trailing bytes are detected and repaired via descriptor-level `ftruncate`.

---

## Architecture & Design Principles

```
  ┌────────────────────────────────────────────────────────┐
  │                 agent-ledger CLI                       │
  └───────────────────────────┬────────────────────────────┘
                              │ POSIX Advisory Lock (flock)
  ┌───────────────────────────▼────────────────────────────┐
  │               Causal State Machine                     │
  │  - 9 Permitted Event Types  - Causal Tool Pairing      │
  │  - Monotonic Sequence Count - Run Completion Sealing   │
  └───────────────────────────┬────────────────────────────┘
                              │ Canonical JSON Serialization
  ┌───────────────────────────▼────────────────────────────┐
  │           Cryptographic Hash Chaining                  │
  │    H_n = SHA-256( H_{n-1} + CanonicalJson(Event_n) )   │
  └───────────┬───────────────────────────────┬────────────┘
              │ Append                        │ Fork
  ┌───────────▼──────────────┐   ┌────────────▼────────────┐
  │ .agent-ledger/events     │   │ Speculative Branch DAG  │
  │ (NDJSON Event Stream)    │   │ (Isolated Checkpoints)  │
  └──────────────────────────┘   └─────────────────────────┘
```

### 1. Cryptographic Tamper-Evidence

Every record in `.agent-ledger/events.ndjson` is cryptographically chained.
* **Genesis Hash**: The genesis hash $H_0$ is defined as the SHA-256 digest of an empty string:
  ```text
  e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  ```
* **Event Hash Chaining**: For any event $n \ge 1$:
  $$H_n = \text{SHA-256}(H_{n-1} + \text{CanonicalJson}(E_n))$$
* **Canonical JSON**: Object keys are recursively sorted lexicographically; whitespace is normalized; unicode characters and raw byte representations are preserved byte-for-byte.

### 2. Causal Event State Machine

The ledger strictly permits exactly **9 event types**:

| Event Type | Causal Invariants & Semantics |
| :--- | :--- |
| `run_started` | Must be seq 1; initializes run metadata, provider, and repetition count. |
| `plan_created` | Records agent reasoning, task objective, and prompt digest. |
| `tool_requested` | Logs pending tool invocation with unique `tool_request_id`. |
| `tool_result_received`| Must match an open `tool_requested` event by `tool_request_id`. |
| `file_modified` | Records file path, operation type (`create`/`modify`/`delete`), and file digest. |
| `test_finished` | Records test suite execution metrics (`passed`, `failed`, `duration_ms`). |
| `checkpoint_created` | Persists an immutable state snapshot; forbidden if tool calls remain open. |
| `branch_forked` | Records branching lineage from parent checkpoint. |
| `run_completed` | Permanently seals the active run; forbidden if tool calls remain open. |

### 3. POSIX Advisory Locking (`flock`)

All ledger read/write operations acquire an exclusive POSIX advisory lock via descriptor-level `flock` on `.agent-ledger/lock`.
* Metadata (PID, timestamp, lock lease duration) is tracked in the lock file.
* If a concurrent process holds the lock, incoming commands fail immediately with exit code **3** (`LOCK_CONTENTION`).
* Stale locks left by terminated processes (`SIGKILL`) are safely cleared.

### 4. Speculative Execution & Branch DAG

Agents can fork speculative reasoning paths:
* Branching creates an isolated execution head rooted at any historical checkpoint.
* Parent branch history is preserved immutably.
* Switching branches updates `.agent-ledger/config.json`, directing subsequent appends to the active branch lineage.

### 5. Atomic Checkpointing & State Reconstruction

* Checkpointing evaluates event history from genesis to reconstruct:
  * Open/resolved tool call map
  * Working filesystem diff state
  * Test execution summaries (`total`, `passed`, `failed`)
* Manifests are written atomically via temporary files, `fsync`, and atomic rename into `.agent-ledger/checkpoints/<id>.json`.

### 6. Descriptor-Level Crash Recovery

In the event of an abrupt process crash during write operations:
* `agent-ledger recover` scans `.agent-ledger/events.ndjson` for torn trailing bytes or incomplete JSON lines.
* Truncates corrupt tail bytes using `fs.ftruncate` at the file-descriptor level.
* Re-validates the entire cryptographic hash chain from genesis to the repaired tail.
* Reconciles branch pointers to ensure integrity.

### 7. Named Scratch Registers

Provides atomic storage and retrieval of arbitrary binary data (including raw bytes, non-UTF-8 streams, and binary blobs):
* Stored in `.agent-ledger/registers/reg_<name>.blob`.
* Register names are strictly validated against `^[a-zA-Z0-9]$`.

---

## CLI Reference

### 1. `init`
Initializes a new `.agent-ledger/` directory in the current working directory.
```bash
agent-ledger init [run_id]
```
* Example: `agent-ledger init eval_trial_001`
* Exit code `6` (`CONFLICT`) if already initialized.

### 2. `append`
Appends a validated JSON event to the active branch.
```bash
agent-ledger append <event_json_path>
```
* Enforces sequential sequence numbering, unique event IDs, causal tool pairing, and cryptographic hash chaining.
* Exit code `2` on schema violation; `4` if attempting to append to a sealed `run_completed` log.

### 3. `checkpoint`
Atomically records a state checkpoint of the active branch.
```bash
agent-ledger checkpoint --id <checkpoint_id>
```
* Blocked with exit code `4` (`STATE_BLOCKED`) if unresolved tool calls remain in-flight.
* Exit code `6` (`CONFLICT`) if checkpoint ID already exists.

### 4. `branch`
Forks a new speculative branch from an existing checkpoint.
```bash
agent-ledger branch --from <checkpoint_id> --name <branch_name>
```
* Preserves parent branch history and switches active branch context.
* Exit code `6` if branch name already exists.

### 5. `replay`
Deterministically replays events starting from a checkpoint.
```bash
agent-ledger replay --from <checkpoint_id> [--step <count>] [--json]
```
* Virtualizes tool executions directly from recorded outputs without re-invoking external tools.

### 6. `recover`
Repairs torn trailing writes and validates cryptographic chain integrity.
```bash
agent-ledger recover
```
* Uses file-descriptor `ftruncate` to strip partial trailing records and realigns branch heads.

### 7. `register-put` & `register-get`
Stores and retrieves binary scratch data.
```bash
agent-ledger register-put --reg <name> <file_path>
agent-ledger register-get --reg <name>
```
* Validates register names matching `^[a-zA-Z0-9]$`. Preserves raw byte fidelity.

### 8. `status`
Displays current workspace status.
```bash
agent-ledger status [--json]
```
* Reports run ID, active branch, event count, last checkpoint, open tool calls, and lock state.

### 9. `export`
Exports a complete canonical JSON execution graph.
```bash
agent-ledger export --format json
```
* Exports branches, event history, checkpoints, tool invocations, and test results.

---

## Exit Codes

`agent-ledger` implements strict, standardized exit codes across all commands:

| Code | Name | Description |
| :---: | :--- | :--- |
| `0` | `SUCCESS` | Command completed successfully. |
| `1` | `USAGE_OR_NOT_FOUND` | Invalid CLI arguments, missing parameters, or target file/checkpoint not found. |
| `2` | `VALIDATION_ERROR` | Schema validation error, monotonic sequence gap, or duplicate event ID. |
| `3` | `LOCK_CONTENTION` | Another process holds the exclusive POSIX advisory lock. |
| `4` | `STATE_BLOCKED` | Action blocked by causal constraints (e.g. pending tool calls or append to sealed run). |
| `5` | `TAMPER_DETECTED` | Historical log tampering or SHA-256 hash chain divergence detected. |
| `6` | `CONFLICT` | Resource already exists (duplicate run init, duplicate checkpoint ID, or branch name collision). |
| `7` | `UNRECOVERABLE_CORRUPTION` | Unrecoverable data corruption detected prior to log tail. |

---

## LLM Evaluation Harness

The benchmark evaluation subsystem evaluates LLM agent execution traces under real-world benchmark specifications.

### Dual Provider Routing

The evaluation harness implements strict dual-provider routing with independent credentials:

```text
Claude Opus 5 ───► EvoLink API ───► POST https://direct.evolink.ai/v1/chat/completions
                     (EVOLINK_API_KEY)

GPT-5.6 Sol   ───► OpenAI API  ───► POST https://api.openai.com/v1/responses
                     (OPENAI_API_KEY)
```

1. **Claude Opus 5 (`claude-opus-5`)**:
   * Routed via **EvoLink** OpenAI-compatible chat completions endpoint.
   * Credential: `EVOLINK_API_KEY`.
   * Endpoint: `POST https://direct.evolink.ai/v1/chat/completions`.
2. **GPT-5.6 Sol (`gpt-5.6-sol`)**:
   * Routed directly to the **Official OpenAI API** using the Responses API contract.
   * Credential: `OPENAI_API_KEY`.
   * Endpoint: `POST https://api.openai.com/v1/responses`.

### Response Validation & Secret Redaction

* **Non-Empty Response Enforcement**: Live evaluations strictly verify that provider responses contain non-empty, whitespace-trimmed text content. Empty or whitespace-only content is rejected as `PROVIDER_ERROR` and never produces an empty-string SHA-256 hash.
* **Deterministic Error Classification**:
  * Missing credential $\rightarrow$ `CONFIGURATION_ERROR`
  * HTTP 401/403 $\rightarrow$ `AUTHENTICATION_ERROR` (no retries)
  * HTTP 429/5xx, timeouts, network errors $\rightarrow$ `PROVIDER_ERROR` (with exponential backoff)
* **Cryptographic Secret Redaction**: All API keys (`sk-...`), Bearer tokens, and credential headers are masked as `[REDACTED]` across logs, errors, and JSON evidence files.

---

## Verification & Benchmark Results

### Unit & Integration Test Suite

```bash
npm test
```

```text
ℹ tests 153
ℹ suites 32
ℹ pass 153
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
* **Coverage**: Core cryptographic primitives, event state machine, POSIX advisory locks, branch DAG, crash recovery, named registers, replay engine, provider adapters, response validation, secret redaction, and offline loopback HTTP mock servers.

### Private Reference Verifier

```bash
npm run verify
```

```text
REFERENCE VERIFY: PASS
  - CHECK-SCHEMA-001: PASS (Schema & causal order verification)
  - CHECK-CRASH-001:  PASS (Descriptor-level ftruncate crash recovery)
  - CHECK-REPLAY-001: PASS (Deterministic replay & tool virtualization)
  - CHECK-DRIFT-001:  PASS (Cryptographic drift & tamper detection)
  - CHECK-BRANCH-001: PASS (Branch isolation & head reconciliation)
  - CHECK-LOCK-001:   PASS (Advisory flock lease & contention rules)
```

### Mutant Benchmark Suite

```bash
npm run evaluate
```

The test harness evaluates the reference implementation and targeted mutants designed to simulate critical failure modes:

| Mutant Target | Injected Vulnerability | Benchmark Result | Detecting Check |
| :--- | :--- | :---: | :--- |
| **`MUTANT-CAUSAL-ORDER`** | Reorders events or bypasses causal validation | **KILLED** | `CHECK-SCHEMA-001` |
| **`MUTANT-TAIL-CRASH`** | Ignores torn trailing bytes on crash recovery | **KILLED** | `CHECK-CRASH-001` |
| **`MUTANT-LIVE-REPLAY`** | Leaks tool side-effects during replay | **KILLED** | `CHECK-REPLAY-001` |
| **`MUTANT-DRIFT-BLIND`** | Fails to detect hash chain divergence | **KILLED** | `CHECK-DRIFT-001` |
| **`MUTANT-BRANCH-OVERWRITE`**| Corrupts parent branch on speculative fork | **KILLED** | `CHECK-BRANCH-001` |
| **`MUTANT-LOCK-OMISSION`** | Omits POSIX advisory lock acquisition | **KILLED** | `CHECK-LOCK-001` |

**Mutant Kill Rate: 6 / 6 (100%)**

### Live Evaluation Summary

```bash
npm run evaluate:live
```

```text
============================================================
                 FINAL LIVE EVALUATION SUMMARY              
============================================================
LIVE CLAUDE OPUS 5: PROVIDER_ERROR
LIVE GPT-5.6-SOL: PROVIDER_ERROR
OVERALL: FAIL
============================================================
EVIDENCE SAVED: evaluation/evidence/live_evaluation.json
EVIDENCE DIGEST: 8fd987f88d3bb2fba47efb0640604b003972416829fab15b664ee3de06c5fb62
============================================================
```
* Both targets successfully exercised against live APIs with verified credentials.
* Claude Opus 5 correctly rejected upstream empty model response without claiming false success.
* GPT-5.6 Sol correctly caught upstream HTTP 429 quota exhaustion.

---

## Quickstart & Verification Commands

### 1. Build and Setup Workspace
```bash
npm run build
bash app-setup/reset.sh
bash app-setup/build.sh
bash app-setup/start.sh
```

### 2. Run Public Test Suite
```bash
npm test
```

### 3. Run Private Reference Verifier
```bash
npm run verify
```

### 4. Run Mutant Evaluation Benchmark
```bash
npm run evaluate
```

### 5. Run Live Evaluation (Optional with API credentials)
```bash
export EVOLINK_API_KEY="<your-evolink-key>"
export OPENAI_API_KEY="<your-openai-key>"
npm run evaluate:live
```
