import json
import pytest


def to_addr_str(addr) -> str:
    if hasattr(addr, "as_hex"):
        return str(addr.as_hex).lower()
    return ("0x" + bytes(addr).hex()).lower()


def mock_studionet(direct_vm, wallet: str, tx_count: int = 2, txs: list = None, block_number: int = 12345):
    if txs is None:
        txs = [
            {"from_address": wallet, "to_address": "0x3333333333333333333333333333333333333333", "created_at": "2026-08-23T00:00:00Z", "hash": "0x111", "block_number": block_number},
            {"from_address": wallet, "to_address": "0x4444444444444444444444444444444444444444", "created_at": "2026-08-24T00:00:00Z", "hash": "0x222", "block_number": block_number},
        ][:tx_count]

    # Handler for Studionet RPC calls
    def rpc_handler(request):
        body_raw = request.get("body", b"")
        if isinstance(body_raw, bytes):
            body_raw = body_raw.decode("utf-8")
        body = json.loads(body_raw) if body_raw else {}
        method = body.get("method")
        req_id = body.get("id", 1)
        if method == "sim_getTransactionsForAddress":
            result = txs
        elif method == "eth_getBlockByNumber":
            result = {"number": hex(block_number), "timestamp": "2026-08-24T00:00:00Z"}
        else:
            result = None
        return {
            "ok": {
                "response": {
                    "status": 200,
                    "headers": {"Content-Type": "application/json"},
                    "body": json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result}).encode("utf-8"),
                }
            }
        }

    direct_vm._live_web_handler = rpc_handler


def mock_llm_response(direct_vm, score=85, reasoning="consistent multi-day activity observed on Studionet"):
    direct_vm.mock_llm(
        r".*VERIFIED STUDIONET EVIDENCE.*",
        json.dumps({"score": score, "reasoning": reasoning}),
    )


# ==============================================================================
# Rejection Item 4 & 10.G: Caller Fabrication / Overwrite Attempts
# ==============================================================================

def test_caller_cannot_evaluate_another_wallet_without_authorization(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)
    bob_addr = to_addr_str(direct_bob)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("caller is not authorized to evaluate this wallet"):
        contract.evaluate_wallet(bob_addr, "")

    record = json.loads(contract.get_humanity_status(bob_addr))
    assert record["evaluated"] is False


def test_caller_cannot_overwrite_another_wallet_reputation(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)
    bob_addr = to_addr_str(direct_bob)

    # Bob evaluates own wallet
    direct_vm.sender = direct_bob
    mock_studionet(direct_vm, bob_addr, tx_count=2)
    mock_llm_response(direct_vm, score=85, reasoning="verified bob")
    contract.evaluate_wallet(bob_addr, "")

    status_before = json.loads(contract.get_humanity_status(bob_addr))
    assert status_before["evaluated"] is True
    assert status_before["score"] == 85
    assert status_before["status"] == "Human"

    # Alice tries to overwrite Bob's reputation
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("caller is not authorized to evaluate this wallet"):
        contract.evaluate_wallet(bob_addr, "")

    status_after = json.loads(contract.get_humanity_status(bob_addr))
    assert status_after["score"] == 85
    assert status_after["status"] == "Human"


def test_negative_caller_cannot_manufacture_verification_with_demo_flag(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)
    direct_vm.sender = direct_alice

    # evaluate_wallet takes exactly 2 arguments (wallet_address, canonical_evidence)
    # Attempting to pass a 3rd argument (like old attestation_passed_demo) reverts with TypeError
    with pytest.raises(TypeError):
        contract.evaluate_wallet(alice_addr, "", True)


# ==============================================================================
# Rejection Item 7: Delegated Evaluator Authorization & Revocation
# ==============================================================================

def test_authorized_evaluator_succeeds_and_records_delegated_mode(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)
    bob_addr = to_addr_str(direct_bob)

    # Bob authorizes Alice
    direct_vm.sender = direct_bob
    contract.set_evaluator_authorization(alice_addr, True)
    assert contract.is_evaluator_authorized(bob_addr, alice_addr) is True

    # Alice evaluates Bob
    direct_vm.sender = direct_alice
    mock_studionet(direct_vm, bob_addr, tx_count=2)
    mock_llm_response(direct_vm, score=85)
    contract.evaluate_wallet(bob_addr, "")

    record = json.loads(contract.get_humanity_status(bob_addr))
    assert record["evaluated"] is True
    assert record["authorization_mode"] == "delegated"
    assert record["authenticated_caller"] == alice_addr
    assert record["evaluated_wallet"] == bob_addr
    assert record["status"] == "Human"

    # Revocation stops evaluator
    direct_vm.sender = direct_bob
    contract.set_evaluator_authorization(alice_addr, False)
    assert contract.is_evaluator_authorized(bob_addr, alice_addr) is False

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("caller is not authorized to evaluate this wallet"):
        contract.evaluate_wallet(bob_addr, "")


# ==============================================================================
# Rejection Item 6: Browser-Scanned / Caller Context Is Strictly Unverified
# ==============================================================================

def test_fabricated_activity_metrics_are_never_authoritative(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)

    direct_vm.sender = direct_alice
    # RPC returns only 1 real transaction
    mock_studionet(direct_vm, alice_addr, tx_count=1)
    mock_llm_response(direct_vm, score=85)

    # Caller submits fake metrics claiming 999999 transactions
    fake_user_payload = json.dumps({"transaction_count": 999999, "active_days": 1000, "unique_contracts": 500})
    contract.evaluate_wallet(alice_addr, fake_user_payload)

    record = json.loads(contract.get_humanity_status(alice_addr))
    # Verified evidence summary must reflect real RPC data (1), not 999999
    assert record["evidence_summary"]["transaction_count"] == 1
    assert record["evidence_provenance"]["retrieval_status"] == "verified_authoritative_rpc"


# ==============================================================================
# Rejection Items 2, 3, 5 & 10.F: Strong Anchors, Real Timestamps, Exact Persisted Consistency
# ==============================================================================

def test_evidence_anchors_and_exact_persisted_consistency(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)

    direct_vm.sender = direct_alice
    mock_studionet(direct_vm, alice_addr, tx_count=2, block_number=777888)
    mock_llm_response(direct_vm, score=85, reasoning="consistent multi-day activity observed on Studionet")
    contract.evaluate_wallet(alice_addr, "")

    record = json.loads(contract.get_humanity_status(alice_addr))
    assert record["wallet"] == alice_addr
    assert record["evaluated_wallet"] == alice_addr
    assert record["score"] == 85
    assert record["score_band"] == "80-100"
    assert record["status"] == "Human"
    assert record["risk"] == "Low"
    assert "consistent multi-day activity" in record["reasoning"]
    assert record["evidence_status"] == "verified_authoritative_rpc"
    assert len(record["evidence_hash"]) == 64
    assert record["evidence_provenance"]["network"] == "studionet"
    assert record["evidence_provenance"]["chain_id"] == 61999
    assert record["evidence_provenance"]["snapshot_block"] == 777888
    assert record["evidence_provenance"]["latest_tx_hash"] == "0x222"
    assert record["evidence_schema_version"] == "2"
    assert record["evidence_summary"]["transaction_count"] == 2
    assert record["evidence_summary"]["snapshot_block"] == 777888
    assert record["evidence_summary"]["latest_tx_hash"] == "0x222"
    assert record["evidence_summary"]["evidence_timestamp"] == "2026-08-24T00:00:00Z"


def test_evidence_commitment_changes_when_canonical_evidence_changes(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)

    direct_vm.sender = direct_alice
    mock_studionet(direct_vm, alice_addr, tx_count=1)
    mock_llm_response(direct_vm, score=50)
    contract.evaluate_wallet(alice_addr, "")
    first_hash = json.loads(contract.get_humanity_status(alice_addr))["evidence_hash"]

    direct_vm.clear_mocks()
    mock_studionet(direct_vm, alice_addr, tx_count=2)
    mock_llm_response(direct_vm, score=85)
    contract.evaluate_wallet(alice_addr, "")
    second_hash = json.loads(contract.get_humanity_status(alice_addr))["evidence_hash"]

    assert first_hash != second_hash


# ==============================================================================
# Rejection Item 10.D: Empty Activity History
# ==============================================================================

def test_empty_history_is_evaluated_deterministically_as_sybil_risk(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)

    direct_vm.sender = direct_alice
    mock_studionet(direct_vm, alice_addr, tx_count=0)
    # Even if LLM is not called or mocked, empty history evaluates deterministically to 0
    contract.evaluate_wallet(alice_addr, "")

    record = json.loads(contract.get_humanity_status(alice_addr))
    assert record["evaluated"] is True
    assert record["score"] == 0
    assert record["score_band"] == "0-39"
    assert record["status"] == "Sybil_Risk"
    assert record["risk"] == "High"
    assert "No observable transaction history" in record["reasoning"]


# ==============================================================================
# Rejection Item 10.H: Failed RPC / Fail Closed
# ==============================================================================

def test_missing_evidence_fails_closed(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)

    direct_vm.sender = direct_alice
    direct_vm.mock_web(
        r".*studio\.genlayer\.com.*",
        {
            "response": {
                "status": 500,
                "headers": {"Content-Type": "text/plain"},
                "body": b"Internal Server Error",
            },
            "method": "POST",
        },
    )

    with direct_vm.expect_revert("Studionet RPC"):
        contract.evaluate_wallet(alice_addr, "")

    record = json.loads(contract.get_humanity_status(alice_addr))
    assert record["evaluated"] is False


# ==============================================================================
# Admin Controls & Registry
# ==============================================================================

def test_admin_revocation_and_duplicate_registry(direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)

    direct_vm.sender = direct_alice
    mock_studionet(direct_vm, alice_addr, tx_count=1)
    mock_llm_response(direct_vm, score=50)
    contract.evaluate_wallet(alice_addr, "")
    contract.evaluate_wallet(alice_addr, "")
    assert len(json.loads(contract.get_registry())) == 1

    with direct_vm.prank(direct_bob):
        with direct_vm.expect_revert("only the contract admin"):
            contract.revoke_status(alice_addr)

    direct_vm.sender = direct_owner
    contract.revoke_status(alice_addr)
    assert contract.get_status(alice_addr) == "Sybil_Risk"
