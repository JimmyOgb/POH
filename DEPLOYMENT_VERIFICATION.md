# Deployment & Source Verification Guide

This document provides complete, reproducible technical instructions for proving that the deployed Proof of Humanity Oracle contract on GenLayer Studionet corresponds exactly to the reviewed source code in this repository.

---

## 1. Deployment Metadata

| Field | Value |
|---|---|
| **Repository** | `https://github.com/JimmyOgb/POH` (proof-of-humanity-oracle) |
| **Branch** | `main` |
| **Target Network** | GenLayer Studionet |
| **Chain ID** | `61999` |
| **RPC URL** | `https://studio.genlayer.com/api` |
| **Contract Name** | `ProofOfHumanityOracle` |
| **Deployed Contract Address** | `0x882E6E8A2Dd5061673716dB46f13EDf576a0E8aF` |
| **GenVM Runner Dependency** | `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` |
| **GenVM Linter Version** | `v0.6.0-rc5` |
| **GenLayer JS SDK** | `genlayer-js@1.1.8` |
| **GenLayer Python SDK** | `genlayer-py@0.19.0rc2` |
| **GenLayer Test SDK** | `genlayer-test@0.30.0rc2` |

---

## 2. Source Code & Cryptographic Commitment

The on-chain contract source file is located at:
```text
contract/poh_oracle.py
```

### Reproducible Source Hash
Reviewers can compute the exact SHA-256 hash of `contract/poh_oracle.py`:

```bash
# On Linux / macOS:
sha256sum contract/poh_oracle.py

# On Windows (PowerShell):
Get-FileHash contract/poh_oracle.py -Algorithm SHA256
```

---

## 3. Step-by-Step Reproduction & Deployment Process

### Prerequisites
- Python 3.12+
- Node.js v20+ / v22+
- `pip install genlayer-py==0.19.0rc2 genlayer-test==0.30.0rc2 genvm-linter`
- `npm install`

### Step 1: Validate Contract Source with GenVM Linter
Run the official GenVM linter to verify syntax, AST validity, and method declarations:

```bash
npm run lint:contract
```

Expected output:
```json
{"ok":true,"lint":{"ok":true,"passed":3},"validate":{"ok":true,"contract":"ProofOfHumanityOracle","methods":10,"view_methods":7,"write_methods":3,"ctor_params":0}}
```

### Step 2: Run Full Regression and Direct Tests
Run the complete regression suite covering validator disagreement, timestamp parsing, caller authorization, and evidence anchors:

```bash
npm test
```

Expected output:
```text
29 passed (19 unit tests + 10 direct tests)
61 passed (frontend tests)
```

### Step 3: Deploy to GenLayer Studionet
Deployment uses the standard `gltest` or `genlayer deploy` pipeline.

To deploy via `gltest`:
```bash
gltest tests/integration/ -v -s --network studionet
```

This compiles `contract/poh_oracle.py`, deploys it to GenLayer Studionet, executes self-evaluation, verifies consensus agreement across real validators, and confirms unauthorized evaluation fail-closed behavior on-chain.

---

## 4. Independent Verification Against On-Chain State

A reviewer can independently query the deployed contract on Studionet using standard JSON-RPC without installing any custom tools:

### Read Admin Address
```bash
curl -X POST https://studio.genlayer.com/api \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "eth_call",
    "params": [{
      "to": "0x882E6E8A2Dd5061673716dB46f13EDf576a0E8aF",
      "data": "0x..."
    }, "latest"]
  }'
```

Or via Python using `genlayer-py`:
```python
from genlayer_py import create_client
from genlayer_py.chains import studionet

client = create_client(studionet)
contract_addr = "0x882E6E8A2Dd5061673716dB46f13EDf576a0E8aF"

# 1. Read Schema Version
schema_version = client.read_contract(contract_addr, "get_evidence_schema_version", args=[])
assert schema_version == "2"

# 2. Read Registry of Evaluated Accounts
registry = client.read_contract(contract_addr, "get_registry", args=[])
print("Evaluated accounts in registry:", registry)

# 3. Read Humanity / Behavioral Status for Evaluated Wallet
status_json = client.read_contract(contract_addr, "get_humanity_status", args=[registry[0]])
print("Persisted record:", status_json)
```

---

## 5. Deployed Interface Specification

The deployed contract exposes exactly the following ABI methods:

### View Methods (Read-Only)
1. `get_admin() -> str`: Returns administrator address.
2. `get_evidence_schema_version() -> str`: Returns active schema version (`"2"`).
3. `get_registry() -> list`: Returns list of evaluated wallet addresses.
4. `get_humanity_status(wallet_address: str) -> str`: Returns JSON-serialized consensus-backed evaluation record.
5. `get_score(wallet_address: str) -> int`: Returns numeric score (0–100).
6. `get_status(wallet_address: str) -> str`: Returns behavioral status (`"Human"`, `"Unknown"`, `"Sybil_Risk"`).
7. `is_evaluator_authorized(wallet_address: str, evaluator_address: str) -> bool`: Checks delegation.

### Write Methods (State Transitions)
1. `evaluate_wallet(wallet_address: str, canonical_evidence: str) -> str`:
   - Authenticated caller must be `wallet_address` or an authorized evaluator.
   - Contract retrieves authoritative Studionet transactions independently.
   - Validators evaluate evidence and establish unanimous consensus on all 7 decision fields.
2. `set_evaluator_authorization(evaluator_address: str, authorized: bool) -> str`:
   - Allows wallet owner to grant or revoke third-party evaluation permissions.
3. `revoke_status(wallet_address: str) -> str`:
   - Admin-only revocation method.
