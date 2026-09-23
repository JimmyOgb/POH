import json
import pytest


def to_addr_str(addr) -> str:
    if hasattr(addr, "as_hex"):
        return str(addr.as_hex).lower()
    return ("0x" + bytes(addr).hex()).lower()


def mock_studionet(direct_vm, wallet: str, tx_count: int = 2, txs: list = None):
    if txs is None:
        txs = [
            {"from_address": wallet, "to_address": "0x3333333333333333333333333333333333333333", "created_at": "2026-08-23T00:00:00Z"},
            {"from_address": wallet, "to_address": "0x4444444444444444444444444444444444444444", "created_at": "2026-08-24T00:00:00Z"},
        ][:tx_count]
    direct_vm.mock_web(
        r".*studio\.genlayer\.com.*",
        {
            "response": {
                "status": 200,
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps({"jsonrpc": "2.0", "id": 1, "result": txs}).encode("utf-8"),
            },
            "method": "POST",
        },
    )


def mock_llm_response(direct_vm, score=85, reasoning="measured activity"):
    direct_vm.mock_llm(
        r".*VERIFIED STUDIONET EVIDENCE.*",
        json.dumps({"score": score, "reasoning": reasoning}),
    )


def test_caller_cannot_evaluate_another_wallet_without_authorization(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)
    bob_addr = to_addr_str(direct_bob)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("caller is not authorized to evaluate this wallet"):
        contract.evaluate_wallet(bob_addr, "", True)

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
    contract.evaluate_wallet(bob_addr, "", True)

    status_before = json.loads(contract.get_humanity_status(bob_addr))
    assert status_before["evaluated"] is True
    assert status_before["score"] == 85
    assert status_before["status"] == "Human"

    # Alice tries to overwrite Bob's reputation
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("caller is not authorized to evaluate this wallet"):
        contract.evaluate_wallet(bob_addr, "", False)

    status_after = json.loads(contract.get_humanity_status(bob_addr))
    assert status_after["score"] == 85
    assert status_after["status"] == "Human"


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
    contract.evaluate_wallet(bob_addr, "", True)

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
        contract.evaluate_wallet(bob_addr, "", True)


def test_fabricated_activity_metrics_are_never_authoritative(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)

    direct_vm.sender = direct_alice
    # RPC returns only 1 real transaction
    mock_studionet(direct_vm, alice_addr, tx_count=1)
    mock_llm_response(direct_vm, score=85)

    # Caller submits fake metrics claiming 999999 transactions
    fake_user_payload = json.dumps({"transaction_count": 999999, "active_days": 1000, "unique_contracts": 500})
    contract.evaluate_wallet(alice_addr, fake_user_payload, True)

    record = json.loads(contract.get_humanity_status(alice_addr))
    # Verified evidence summary must reflect real RPC data (1), not 999999
    assert record["evidence_summary"]["transaction_count"] == 1
    assert record["evidence_provenance"]["retrieval_status"] == "verified_authoritative_rpc"


def test_evidence_is_bound_to_wallet_and_studionet(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)

    direct_vm.sender = direct_alice
    mock_studionet(direct_vm, alice_addr, tx_count=2)
    mock_llm_response(direct_vm, score=85)
    contract.evaluate_wallet(alice_addr, "", True)

    record = json.loads(contract.get_humanity_status(alice_addr))
    assert record["wallet"] == alice_addr
    assert record["evaluated_wallet"] == alice_addr
    assert record["evidence_provenance"]["network"] == "studionet"
    assert record["evidence_provenance"]["chain_id"] == 61999
    assert record["evidence_schema_version"] == "2"
    assert len(record["evidence_hash"]) == 64


def test_evidence_commitment_changes_when_canonical_evidence_changes(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)

    direct_vm.sender = direct_alice
    mock_studionet(direct_vm, alice_addr, tx_count=1)
    contract.evaluate_wallet(alice_addr, "", False)
    first_hash = json.loads(contract.get_humanity_status(alice_addr))["evidence_hash"]

    direct_vm.clear_mocks()
    mock_studionet(direct_vm, alice_addr, tx_count=2)
    contract.evaluate_wallet(alice_addr, "", False)
    second_hash = json.loads(contract.get_humanity_status(alice_addr))["evidence_hash"]

    assert first_hash != second_hash


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
        contract.evaluate_wallet(alice_addr, "", True)

    record = json.loads(contract.get_humanity_status(alice_addr))
    assert record["evaluated"] is False


def test_demo_attestation_failure_records_validated_evidence(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)

    direct_vm.sender = direct_alice
    mock_studionet(direct_vm, alice_addr, tx_count=2)
    contract.evaluate_wallet(alice_addr, "", False)

    record = json.loads(contract.get_humanity_status(alice_addr))
    assert record["score"] == 0
    assert record["score_band"] == "0-39"
    assert record["status"] == "Sybil_Risk"
    assert record["risk"] == "High"
    assert len(record["evidence_hash"]) == 64
    assert record["evidence_schema_version"] == "2"


def test_contract_advertises_schema_v2_for_frontend_write_gating(direct_vm, direct_deploy):
    contract = direct_deploy("contract/poh_oracle.py")
    assert contract.get_evidence_schema_version() == "2"


def test_empty_history_is_valid_but_assessed_from_insufficient_signal(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)

    direct_vm.sender = direct_alice
    mock_studionet(direct_vm, alice_addr, tx_count=0)
    mock_llm_response(direct_vm, score=20, reasoning="no observed activity")
    contract.evaluate_wallet(alice_addr, "", True)

    record = json.loads(contract.get_humanity_status(alice_addr))
    assert record["score_band"] == "0-39"
    assert record["status"] == "Sybil_Risk"


def test_admin_revocation_and_duplicate_registry(direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner):
    contract = direct_deploy("contract/poh_oracle.py")
    alice_addr = to_addr_str(direct_alice)

    direct_vm.sender = direct_alice
    mock_studionet(direct_vm, alice_addr, tx_count=1)
    contract.evaluate_wallet(alice_addr, "", False)
    contract.evaluate_wallet(alice_addr, "", False)
    assert len(json.loads(contract.get_registry())) == 1

    with direct_vm.prank(direct_bob):
        with direct_vm.expect_revert("only the contract admin"):
            contract.revoke_status(alice_addr)

    direct_vm.sender = direct_owner
    contract.revoke_status(alice_addr)
    assert contract.get_status(alice_addr) == "Sybil_Risk"
