# Behavioral assessment oracle architecture

The frontend connects to the authenticated user's wallet using the public
`genlayer-js@1.1.8` client. The contract owns the authoritative evaluation record
and registry: it verifies caller authorization (self-evaluation via
`gl.message.sender_address == wallet` or explicit on-chain delegation via
`is_evaluator_authorized`), queries authoritative Studionet RPC evidence directly
inside the GenLayer nondeterministic boundary, hashes the canonical evidence with
provenance and caller binding, runs the LLM leader and independent validator,
then persists the consensus result.

The assessment is limited to the quality and behavioral signal of authoritative
evidence. It does not prove identity, uniqueness, wallet ownership, or
cryptographic humanity.

## Caller Authorization & Evaluator Delegation

Evaluations are strictly authenticated:
1. **Self-Evaluation (Default)**: `gl.message.sender_address == evaluated_wallet`.
   The connected wallet signs and submits the evaluation for its own address.
2. **Delegated Evaluation**: A third party can only evaluate a wallet if the wallet
   owner has explicitly registered them beforehand via `set_evaluator_authorization(evaluator, True)`.
3. **Fail-Closed Gate**: Unauthorized callers are rejected on-chain immediately with
   `[EXPECTED] caller is not authorized to evaluate this wallet` and cannot create or
   overwrite another wallet's reputation.

## Authoritative Studionet Evidence & Quarantined Context

The contract does NOT trust caller-supplied activity metrics.
- Authoritative evidence is fetched inside `gl.nondet` via Studionet RPC
  (`sim_getTransactionsForAddress`).
- If Studionet RPC cannot be reached or fails, evaluation fails closed.
- Any caller-supplied JSON or prose is strictly quarantined as `unverified_context`.
  The evaluation prompt strictly instructs validators that user-supplied context
  must never override or establish activity facts (tx count, active days, etc.).

The contract computes SHA-256 over sorted-key, compact canonical JSON binding
the network, chain ID, wallet address, authenticated caller, authorization mode,
retrieved canonical metrics, and provenance metadata. This is an integrity
commitment verifying exactly what canonical evidence and authorization context
was submitted to consensus.

## Consensus

Validators independently produce a score and explanation. The contract
normalizes the score into deterministic bands:

| Score | Canonical band | Status | Risk |
|---|---|---|---|
| 0–39 | `0-39` | `Sybil_Risk` | High |
| 40–69 | `40-69` | `Unknown` | Medium |
| 70–79 | `70-79` | `Unknown` | Medium |
| 80–100 | `80-100` | `Human` | Low |

The custom validator comparator requires the canonical band and derived status
to match. Exact scores within a band and reasoning text may differ. Status is
never accepted from the model; it is derived by `status_for_band`.

## Attestation boundary

`attestation_passed_demo` is a boolean demo gate. This implementation does not
verify a ZK proof or any cryptographic artifact. A false value records a
deterministic `Sybil_Risk` result and skips the LLM call.

## Frontend scan and transaction lifecycle

The normal frontend journey is connect wallet → scan wallet → review observed
metrics/source → submit the canonical JSON → wait for GenLayer finalization →
read the persisted result. A failed or unsupported scan never creates a fake
payload. The demo attestation remains under developer options.

Writes use `genlayer-js`: submit → `getTransaction` polling through pending,
proposing, committing, revealing and finalizing → check
`txExecutionResultName` → read `get_humanity_status` / `get_registry`. A
finalized transaction with `FINISHED_WITH_ERROR` is a failure and never causes
the UI to render a successful result. There is no timeout that converts a
still-processing transaction into a failure.
