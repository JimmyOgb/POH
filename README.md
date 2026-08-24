# Proof of Humanity Oracle

> **Consensus-backed behavioral evidence and reputation for Web3 wallets, powered by GenLayer.**

Proof of Humanity Oracle (POH) is a GenLayer Studionet application that evaluates **observable on-chain wallet behavior** and turns that evidence into a consensus-backed behavioral reputation result.

The project is designed for Web3 applications that need behavioral signals for ecosystem access, grants, DAO participation, airdrops, reputation, or Sybil/bot-risk screening.

**POH does not prove that a wallet belongs to a human.** It does not verify identity, wallet ownership, uniqueness, or personhood. Its purpose is narrower: evaluate the behavioral evidence that is actually observable and submitted to the contract.

---

## Why this matters in Web3

Web3 applications often need to make decisions about wallets without having a reliable behavioral reputation layer.

Examples include:

- Grant programs evaluating ecosystem participation.
- DAOs evaluating participation and governance signals.
- Ecosystems screening for low-history or suspicious accounts.
- Airdrop systems using behavioral evidence as one eligibility signal.
- Protocols that want reputation signals without relying entirely on a centralized scoring service.

POH explores:

**observable wallet behavior → canonical evidence → independent evaluation → GenLayer consensus → on-chain reputation**

The result is a **behavioral evidence signal**, not a declaration of someone's identity.

---

## How it works

```text
Wallet
  │
  ▼
Public GenLayer Studionet behavioral history
  │
  ▼
Address-indexed wallet scan
  │
  ▼
Canonical behavioral evidence (schema v2)
  │
  ▼
GenLayer leader evaluation
  │
  ▼
Independent validator evaluations
  │
  ▼
GenLayer consensus
  │
  ▼
Persisted on-chain behavioral reputation
```

### 1. Connect a wallet

The connected wallet address becomes the subject of the assessment. The browser wallet signs the eventual transaction locally; private keys are not stored in the application.

### 2. Collect observable behavioral evidence

The production scanner uses:

```text
sim_getTransactionsForAddress(address)
```

with scan mode:

```text
address_index
```

This avoids downloading hundreds or thousands of blocks merely to discover wallet activity.

The scanner can derive:

- transaction count
- active days
- unique destination contracts
- activity intervals
- daily activity distribution
- median activity interval
- repetition ratio
- regularity indicators
- source and coverage metadata

Transaction hashes are retained separately as audit metadata and are **not** included in the LLM-facing canonical evidence.

### 3. Canonicalize the evidence

The current evidence schema is version `2`.

Supported coverage types are:

```text
block_range
indexed_history
```

Indexed evidence identifies its actual coverage method instead of pretending that a block range was scanned.

Example:

```json
{
  "schema_version": "2",
  "wallet": "0x...",
  "chain_id": "61999",
  "source": "genlayer_studionet_rpc",
  "scan_method": "address_index",
  "coverage_type": "indexed_history",
  "indexed_records": 164,
  "transaction_count": 160,
  "active_days": 37,
  "unique_contracts": 73
}
```

The complete canonical evidence contains the validated behavioral metrics supported by the scanner.

Canonicalization uses deterministic normalization and stable JSON serialization. The contract computes and stores a SHA-256 evidence hash.

### 4. Evaluate with GenLayer

The canonical evidence is submitted to the Intelligent Contract.

The GenLayer leader evaluates the evidence and independent validators evaluate the same canonical evidence.

Evaluators are instructed not to infer identity, ownership, uniqueness, or personhood from behavioral observations.

### 5. Reach consensus

GenLayer consensus determines the accepted result.

The accepted behavioral assessment is then persisted on-chain, giving downstream applications a reusable reputation signal.

---

# Behavioral reputation, not Proof of Humanity

The project's name is historical; its current product positioning is **behavioral evidence and reputation**.

The system cannot establish:

- who controls a wallet
- whether the controller is a human
- whether one human controls multiple wallets
- whether activity was automated
- the real-world identity of the wallet owner

A wallet with strong observable activity therefore does not become "proven human," and a wallet with no observed activity does not become "proven Sybil."

The system evaluates the evidence that was actually supplied.

---

# Evidence coverage

## Indexed history

The production scanner prefers:

```text
sim_getTransactionsForAddress(address)
```

with:

```text
scan_method = address_index
coverage_type = indexed_history
```

This provides indexed wallet history without requiring a large block download.

The scanner records the number of indexed records returned and the records matching the connected wallet.

A real Studionet diagnostic for the confirmed wallet produced:

```text
Indexed records:       164
Matching transactions: 160
Active days:           37
Unique contracts:      73
Scan method:           address_index
```

These are observed diagnostic values, not expected values for every wallet.

## Block-range coverage

Schema v2 also supports:

```text
coverage_type = block_range
```

when a bounded block scan is explicitly performed.

Block-range evidence must accurately represent its scanned range. A bounded block scanner remains available as a fallback when the indexed RPC method is unavailable.

---

# Evidence schema v2

The current schema is:

```text
schema_version = "2"
```

For indexed history, the required coverage metadata includes:

```text
scan_method = address_index
coverage_type = indexed_history
indexed_records
```

Indexed evidence must not fabricate:

```text
scan_start_block
scan_end_block
blocks_scanned
```

when those values were not obtained from an actual block-range scan.

The contract validates:

- wallet address format
- wallet binding
- chain binding
- schema version
- coverage type
- numeric bounds
- array limits
- evidence size
- deterministic normalization

Legacy schema-v1 block-range evidence is accepted and normalized by the current contract implementation.

---

# Consensus architecture

```text
Canonical evidence
       │
       ▼
   GenLayer Leader
       │
       ├───────────────┐
       ▼               ▼
 Validator A       Validator B
       │               │
       └───────┬───────┘
               ▼
       GenLayer Consensus
               │
               ▼
       Accepted result
               │
               ▼
        On-chain state
```

Validators independently evaluate the same canonical evidence.

The browser does not simply choose an arbitrary score. GenLayer consensus determines the accepted result.

This is the core value of making the behavioral evaluator an Intelligent Contract rather than only an off-chain scoring script.

---

# Result bands

| Score | Interpretation |
|---|---|
| **80–100** | Strong behavioral evidence |
| **40–79** | Moderate behavioral evidence |
| **0–39** | Insufficient behavioral evidence |

These are **behavioral evidence and reputation bands**, not identity or personhood scores.

A `0–39` result means that the supplied evidence was insufficient or weak for a strong behavioral assessment.

It does **not** mean:

> "This person is a Sybil."

A high score does not mean:

> "This wallet is proven to belong to a human."

Applications should treat the result as one behavioral signal among their broader policy controls.

---

# On-chain contract

## Current deployment

```text
Network:       GenLayer Studionet
Chain ID:      61999
Contract:      0x4FAE1cdCB3c72ec3B22A5b1649D94fE3c4530247
Evidence:      schema v2
```

Primary write method:

```text
evaluate_wallet(string, string, bool)
```

Arguments:

```text
1. walletAddress
2. canonicalEvidence
3. attestationPassedDemo
```

The frontend normalizes these to primitive types:

```text
walletAddress         → string
canonicalEvidence     → string
attestationPassedDemo → boolean
```

This prevents a typed GenLayer address object from being accidentally encoded as address calldata when the contract expects a string.

---

# Contract reads

The deployed contract exposes read functionality including:

```text
get_admin()
get_evidence_schema_version()
get_humanity_status(string)
get_registry()
get_score(string)
get_status(string)
```

The frontend can read persisted assessment state independently from the transaction submission flow.

---

# Persisted result

After a successful evaluation, the contract can persist information associated with a wallet including:

- score
- score band
- status
- risk classification
- reasoning
- evaluator information
- evidence hash
- evidence schema version

The registry provides a view of wallets for which assessments have been recorded.

---

# Auditability

Transaction hashes are kept separately from the canonical LLM-facing evidence.

```text
Canonical evidence
        │
        └── evaluated by GenLayer

Scan audit metadata
        │
        └── transaction hashes
```

This keeps audit information available without unnecessarily adding transaction identifiers to the behavioral evaluation prompt.

The contract stores a deterministic evidence hash, providing a commitment to the canonical evidence representation used for evaluation.

---

# Frontend architecture

The frontend is a static HTML/JavaScript application.

Entry point:

```text
frontend/index.html
```

Important components include:

```text
frontend/
├── app.js
├── config.js
├── contract.js
├── contract-connection.js
├── evidence-state.js
├── result-presentation.js
├── scan-flow.js
├── scanner.js
├── transaction.js
└── wallet.js
```

The application separates wallet state, scanner state, evidence state, contract connectivity, transaction polling, and result presentation.

This helps prevent stale wallet or stale scan data from being submitted.

---

# Scanner reliability

The earlier block-by-block approach could require thousands of RPC calls and remain in a scanning state for too long.

The current production scanner instead prefers the address-indexed method:

```text
sim_getTransactionsForAddress
```

This substantially reduces the RPC work required to discover wallet history.

The scanner includes:

- bounded request timeouts
- cancellation
- stale-wallet protection
- RPC error handling
- malformed-record handling
- deterministic evidence generation
- explicit scan-method reporting

A network failure is never silently converted into zero activity.

This distinction is important:

```text
RPC failure ≠ zero observed activity
```

---

# Transaction handling

GenLayer transaction finalization and execution success are treated separately.

The frontend tracks lifecycle states such as:

```text
PENDING
PROPOSING
COMMITTING
REVEALING
FINALIZED
```

A transaction reaching `FINALIZED` does not automatically mean the contract execution succeeded.

The application validates the final execution result before treating an assessment as successful.

Transient RPC failures during transaction polling are retried with bounded backoff.

---

# Local development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run project checks:

```bash
npm run check
```

Build the frontend:

```bash
npm run build
```

The frontend is static and uses the repository's configured dependencies and network configuration.

Tests and checks should pass before deployment.

---

# Vercel deployment

The intended production deployment is a standalone Vercel project independent of the previous Lovable deployment.

Recommended settings:

```text
Framework Preset: Other
Root Directory:   repository root
Build Command:    npm run build
Output Directory: frontend
```

The repository includes:

```text
vercel.json
```

No environment variables are required by the current frontend configuration.

After deployment, verify the public production bundle contains:

```text
0x4FAE1cdCB3c72ec3B22A5b1649D94fE3c4530247
sim_getTransactionsForAddress
address_index
```

and does not contain stale contract or scanner configuration from an earlier deployment.

---

# Configuration and security

The current frontend uses static configuration for:

```text
Network:       studionet
Chain ID:      61999
Contract:      0x4FAE1cdCB3c72ec3B22A5b1649D94fE3c4530247
Schema:        v2
Scanner:       sim_getTransactionsForAddress
Scan mode:     address_index
```

There should be no:

- private keys
- seed phrases
- wallet credentials
- API secrets
- user passwords

in this repository.

The browser wallet signs transactions locally.

---

# Repository structure

```text
POH/
├── contract/
│   └── poh_oracle.py
├── frontend/
│   ├── index.html
│   ├── app.js
│   ├── config.js
│   ├── contract.js
│   ├── contract-connection.js
│   ├── evidence-state.js
│   ├── result-presentation.js
│   ├── scan-flow.js
│   ├── scanner.js
│   ├── transaction.js
│   └── wallet.js
├── tests/
│   ├── frontend/
│   ├── direct/
│   └── integration/
├── architecture.md
├── gltest.config.yaml
├── package.json
├── package-lock.json
├── pytest.ini
├── requirements.txt
├── vercel.json
└── README.md
```

---

# Development status

The current implementation includes:

```text
✓ GenLayer Studionet
✓ Contract schema v2
✓ Indexed wallet history
✓ sim_getTransactionsForAddress
✓ Canonical behavioral evidence
✓ Deterministic evidence hashing
✓ GenLayer leader evaluation
✓ Independent validator evaluation
✓ Consensus-backed result
✓ On-chain persistence
✓ Plain-language result presentation
✓ Vercel-ready static frontend
```

The project is designed as a reusable behavioral evidence primitive rather than a standalone identity-verification system.

---

# Potential Web3 applications

POH can serve as a behavioral evidence layer for applications such as:

```text
DAO
 ├── participation signals
 ├── behavioral reputation
 └── governance risk controls

Grant program
 ├── ecosystem history
 ├── behavioral evidence
 └── applicant reputation signals

Airdrop / ecosystem access
 ├── wallet history
 ├── activity diversity
 └── Sybil/bot-risk signals

Web3 application
 └── on-chain behavioral reputation
```

These are potential integration patterns. They do not mean that the current contract automatically implements every downstream policy.

---

# Design principles

### Evidence before conclusion

The evaluator should reason from submitted observations rather than invent facts.

### Observable behavior, not identity

The system evaluates blockchain behavior rather than determining who a person is.

### Deterministic evidence

Equivalent observations should produce a stable canonical representation and evidence hash.

### Independent evaluation

Leader and validator evaluations provide independent judgments over the same evidence.

### Consensus-backed results

The accepted assessment is determined through GenLayer consensus rather than a single centralized scoring process.

### Honest coverage

The application must never claim blocks were scanned when the evidence came from an address index.

### Failure is not inactivity

RPC failures, timeouts, and incomplete scans must never silently become zero-activity evidence.

### Context matters

Behavioral reputation should be combined with application-specific policies rather than treated as a universal identity score.

---

# Known limitations

### Public RPC availability

Public GenLayer Studionet RPC infrastructure can experience latency, temporary errors, or service interruptions.

### Indexed-history coverage

The address-indexed method returns the history exposed by the Studionet index. It should not be described as a cryptographic guarantee that every historical account action is represented.

### Behavioral evidence is partial

The result only describes the observations included in the canonical evidence submitted for evaluation.

### Automation is not directly proven

Regularity or repetition can be behavioral signals, but the system does not cryptographically prove whether activity was manual or automated.

### Reputation is contextual

A score useful for one application may not be sufficient for another. Integrators should define their own policies for how behavioral reputation affects access, rewards, governance, or risk.

---

# Disclaimer

**Proof of Humanity Oracle does not prove humanity.**

It does not verify:

- identity
- wallet ownership
- uniqueness
- personhood

A behavioral reputation score is an evidence signal derived from observable blockchain activity.

It should be combined with other controls when used for important decisions.

---

## License

See [LICENSE](LICENSE) for the project's license.
