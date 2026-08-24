import json


VALID_WALLET = "0x1111111111111111111111111111111111111111"


def evidence(wallet=VALID_WALLET, **changes):
    value = {
        "schema_version": "2", "wallet": wallet, "chain_id": 61999,
        "source": "genlayer_studionet_rpc", "scan_method": "address_index",
        "coverage_type": "indexed_history", "indexed_records": 2, "transaction_count": 2,
        "active_days": 2, "unique_contracts": 2, "activity_intervals_seconds": [100, 200],
        "daily_activity_counts": [1, 0, 1], "median_interval_seconds": 150,
        "repetition_ratio_bps": 0, "regularity_score_bps": 5000,
        "evidence_timestamp": "2026-08-23T00:00:00.000Z",
    }
    value.update(changes)
    return json.dumps(value)


def test_demo_attestation_failure_records_validated_evidence(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    direct_vm.sender = direct_alice
    contract.evaluate_wallet(VALID_WALLET, evidence(), False)
    record = json.loads(contract.get_humanity_status(VALID_WALLET))
    assert record["score"] == 0
    assert record["score_band"] == "0-39"
    assert record["status"] == "Sybil_Risk"
    assert len(record["evidence_hash"]) == 64
    assert record["evidence_schema_version"] == "2"


def test_contract_advertises_schema_v2_for_frontend_write_gating(direct_vm, direct_deploy):
    contract = direct_deploy("contract/poh_oracle.py")
    assert contract.get_evidence_schema_version() == "2"


def test_valid_evidence_uses_contract_consensus_result(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    direct_vm.sender = direct_alice
    direct_vm.mock_llm(r".*canonical evidence object.*", json.dumps({"score": 85, "reasoning": "measured activity"}))
    contract.evaluate_wallet(VALID_WALLET, evidence(), True)
    record = json.loads(contract.get_humanity_status(VALID_WALLET))
    assert record["score_band"] == "80-100"
    assert record["status"] == "Human"


def test_empty_history_is_valid_but_assessed_from_insufficient_signal(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    direct_vm.sender = direct_alice
    empty = evidence(transaction_count=0, active_days=0, unique_contracts=0, activity_intervals_seconds=[], daily_activity_counts=[], median_interval_seconds=0)
    direct_vm.mock_llm(r".*canonical evidence object.*", json.dumps({"score": 20, "reasoning": "no observed activity"}))
    contract.evaluate_wallet(VALID_WALLET, empty, True)
    assert json.loads(contract.get_humanity_status(VALID_WALLET))["score_band"] == "0-39"


def test_malformed_and_impossible_evidence_is_rejected(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("canonical_evidence must be valid JSON"):
        contract.evaluate_wallet(VALID_WALLET, "not json", True)
    with direct_vm.expect_revert("missing evidence field"):
        contract.evaluate_wallet(VALID_WALLET, json.dumps({"schema_version": "1"}), True)
    with direct_vm.expect_revert("indexed_records"):
        contract.evaluate_wallet(VALID_WALLET, evidence(transaction_count=3), True)
    with direct_vm.expect_revert("canonical_evidence is too long"):
        contract.evaluate_wallet(VALID_WALLET, "x" * 20001, True)


def test_wallet_and_chain_must_match_evidence(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("does not match wallet_address"):
        contract.evaluate_wallet(VALID_WALLET, evidence(wallet="0x2222222222222222222222222222222222222222"), True)
    with direct_vm.expect_revert("chain_id must be Studionet"):
        contract.evaluate_wallet(VALID_WALLET, evidence(chain_id=1), True)


def test_evidence_hash_is_deterministic_and_changes_with_canonical_data(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contract/poh_oracle.py")
    direct_vm.sender = direct_alice
    contract.evaluate_wallet(VALID_WALLET, evidence(), False)
    first = json.loads(contract.get_humanity_status(VALID_WALLET))["evidence_hash"]
    contract.evaluate_wallet(VALID_WALLET, evidence(transaction_count=1, active_days=1, unique_contracts=1, activity_intervals_seconds=[], daily_activity_counts=[1]), False)
    second = json.loads(contract.get_humanity_status(VALID_WALLET))["evidence_hash"]
    assert first != second


def test_admin_revocation_and_duplicate_registry(direct_vm, direct_deploy, direct_alice, direct_bob, direct_owner):
    contract = direct_deploy("contract/poh_oracle.py")
    direct_vm.sender = direct_alice
    contract.evaluate_wallet(VALID_WALLET, evidence(), False)
    contract.evaluate_wallet(VALID_WALLET, evidence(transaction_count=1, active_days=1, unique_contracts=1, activity_intervals_seconds=[], daily_activity_counts=[1]), False)
    assert len(json.loads(contract.get_registry())) == 1
    with direct_vm.prank(direct_bob):
        with direct_vm.expect_revert("only the contract admin"):
            contract.revoke_status(VALID_WALLET)
    direct_vm.sender = direct_owner
    contract.revoke_status(VALID_WALLET)
    assert contract.get_status(VALID_WALLET) == "Sybil_Risk"
