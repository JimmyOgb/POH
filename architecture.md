# Behavioral Assessment Oracle Architecture & Trust Boundary

Proof of Humanity Oracle (POH) is a GenLayer Studionet intelligent contract providing **consensus-backed behavioral reputation** for Web3 accounts.

> **CRITICAL TRUST BOUNDARY DEFINITION**:
> POH evaluates **observable on-chain behavioral history**, not biological humanity, legal identity, uniqueness, or personhood. High scores represent consistent, human-like activity patterns in observable history; low scores represent weak or bot-like activity patterns. The system makes no claim of cryptographic proof of identity.

---

## 1. Trust Boundary & Authority Model

### What the Caller Controls
- **Target Wallet Address**: The account to be evaluated.
- **Transaction Submission**: Initiating the evaluation transaction signed by the caller's key.
- **Unverified Context**: Optional caller-provided context (e.g., frontend scan diagnostic metadata). The contract **strictly quarantines** this context. It is never treated as authoritative factual data and cannot establish transaction counts or activity metrics.
- **Evaluator Delegation**: Wallet owners may authorize third-party evaluators via `set_evaluator_authorization(evaluator, True)`.

### What the Contract Retrieves Independently
- Inside the GenLayer nondeterministic boundary (`gl.nondet`), the contract **independently contacts the authoritative Studionet JSON-RPC endpoint** (`https://studio.genlayer.com/api`).
- It executes `sim_getTransactionsForAddress` to fetch the authoritative transaction history for the target wallet directly from the ledger state.
- It executes `eth_getBlockByNumber("latest", False)` to capture the authoritative latest block number and block timestamp.
- **Browser-scanned/displayed evidence is informational only.** The authoritative evidence used for the reputation decision is the data retrieved and verified by the contract's own execution path.

### What is Hashed and Committed
- The contract computes SHA-256 over a canonical, sorted-key, deterministic JSON object binding:
  - Network & chain ID (`61999`)
  - Target wallet address
  - Authenticated caller address (`gl.message.sender_address`)
  - Authorization mode (`self` or `delegated`)
  - Authoritative metrics (transaction count, active days, unique contracts, intervals, daily counts, median interval, repetition ratio, regularity)
  - Strong anchors (`snapshot_block`, `latest_tx_hash`, `observed_tx_hashes`, `evidence_timestamp`)
  - Evidence provenance tag (`studionet_authoritative_rpc`)
- This `evidence_hash` commits to the exact evidence used during evaluation. Changed or stale evidence produces a different hash, making alterations detectable.

---

## 2. Caller Authentication & Overwrite Protection

1. **Authentication Enforcement**:
   - For self-evaluations: `gl.message.sender_address.lower() == target_wallet.lower()`.
   - For delegated evaluations: `is_evaluator_authorized(target_wallet, gl.message.sender_address) == True`.
2. **Fail-Closed Gate**:
   - Any unauthorized caller attempting to evaluate or overwrite another wallet's reputation is rejected on-chain immediately with:
     `[EXPECTED] caller is not authorized to evaluate this wallet`.
   - No arbitrary caller can manufacture or overwrite another participant's verified reputation.

---

## 3. Real Evidence Timestamp & Anchors

- **Verifiable Timestamp**: Derived authoritatively from the latest transaction timestamp in Studionet history or the latest Studionet block timestamp. Hard-coded, fake, or local machine timestamps are rejected.
- **Validation**: Timestamps must be non-empty, valid ISO 8601 or numeric epoch strings. Malformed, empty, or whitespace timestamps fail closed.
- **Strong Anchors Persisted**:
  - `snapshot_block`: Latest block number retrieved from Studionet RPC.
  - `latest_tx_hash`: Transaction hash of the most recent on-chain action.
  - `observed_tx_hashes`: List of verifiable transaction hashes from Studionet history.
  - `evidence_timestamp`: Authoritative evidence timestamp.

---

## 4. Elimination of Demo Attestation & Bypasses

- `attestation_passed_demo`, boolean demo bypass flags, and trusted caller shortcuts are **completely eliminated** from the contract, frontend, and tests.
- There is no mechanism for any caller to manufacture a verified attestation by setting a flag.
- The **only** path to a verified result is the full multi-validator consensus flow over authoritative Studionet evidence.

---

## 5. Complete Consensus-Backed Output

GenLayer validators evaluate the canonical evidence independently using the nondeterministic LLM runner.

### Persisted Decision Fields
Validators must agree on the **complete persisted result object**:
1. `status` (`"Human"`, `"Unknown"`, `"Sybil_Risk"`)
2. `score` (`0` to `100`)
3. `score_band` (`"80-100"`, `"70-79"`, `"40-69"`, `"0-39"`)
4. `risk` (`"Low"`, `"Medium"`, `"High"`)
5. `reasoning` (Validator explanation text)
6. `evidence_status` (`"verified"`)
7. `evidence_hash` (Canonical SHA-256 evidence commitment)

### Strict Fail-Closed Agreement
- The validator comparison function `consensus_agrees(leader, validator)` requires **exact matching on every single decision field above**.
- Disagreement on score, status, band, risk, reasoning, evidence status, or evidence hash immediately causes consensus failure.
- Incomplete or failed consensus **never** becomes a verified persisted reputation result.
- No leader-only field may silently survive into contract state.

---

## 6. Score Bands & Behavioral Normalization

| Score | Canonical Band | Status | Risk Level | Behavioral Meaning |
|---|---|---|---|---|
| **80–100** | `80-100` | `Human` | Low | Consistent, diverse, multi-day activity pattern |
| **70–79** | `70-79` | `Unknown` | Medium | Moderate activity with limited history |
| **40–69** | `40-69` | `Unknown` | Medium | Sparse, low-frequency, or repetitive activity |
| **0–39** | `0-39` | `Sybil_Risk` | High | Minimal, zero, or highly automated activity |

*Note: Status is derived deterministically from the score band by `status_for_band`. It is never accepted directly from raw model prose.*

---

## 7. Persisted State & Contract Interface

### Primary Methods
- `evaluate_wallet(wallet_address: str, canonical_evidence: str)`: Evaluates wallet with independent RPC retrieval and multi-validator consensus.
- `set_evaluator_authorization(evaluator: str, authorized: bool)`: Authorize/revoke delegated evaluators.
- `is_evaluator_authorized(wallet: str, evaluator: str) -> bool`: Query authorization.
- `get_humanity_status(wallet: str) -> str`: Returns full consensus-backed evaluation record.
- `get_registry() -> list`: List of evaluated wallets.
- `get_admin() -> str`: Contract administrator address.
- `get_evidence_schema_version() -> str`: Active schema version (`"2"`).
