# Behavioral assessment oracle architecture

The frontend scans a bounded range of real Studionet blocks using the public
`genlayer-js@1.1.8` read client. It derives a structured evidence object from
full transaction objects, displays the source/range, and submits that object to
the contract. The contract owns the authoritative evaluation record and
registry: it validates/canonicalizes the object, hashes it, runs the LLM leader
and independent validator, then persists the consensus result.

The assessment is limited to the quality and behavioral signal of submitted
evidence. It does not prove identity, uniqueness, wallet ownership, or
cryptographic humanity.

## Canonical evidence boundary

The contract does not pretend to fetch arbitrary wallet history. The frontend
source is `genlayer_studionet_rpc`, scanning the latest configurable 5,000
blocks by default. The evidence includes the exact block range, counts, active
days, unique transaction targets, sampled intervals, daily counts, repetition
ratio, regularity score, and collection timestamp. The contract rejects prose,
missing fields, invalid types, wallet/chain mismatches, inconsistent counts,
and out-of-range values. Unknown JSON fields are discarded before prompting.

The contract computes SHA-256 over sorted-key, compact canonical JSON and stores
the resulting `evidence_hash` with a compact summary. This is an evidence
commitment, not proof that the source was complete, accurate, or controlled by
the wallet owner.

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
