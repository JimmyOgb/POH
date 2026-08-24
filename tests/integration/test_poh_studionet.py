import json

import pytest
from gltest import get_contract_factory
from gltest.assertions import tx_execution_succeeded


pytestmark = pytest.mark.slow


def canonical_evidence(wallet):
    return json.dumps({
        "schema_version": "2", "wallet": wallet, "chain_id": 61999,
        "source": "genlayer_studionet_rpc", "scan_method": "address_index",
        "coverage_type": "indexed_history", "indexed_records": 2, "transaction_count": 2,
        "active_days": 2, "unique_contracts": 2, "activity_intervals_seconds": [100, 200],
        "daily_activity_counts": [1, 0, 1], "median_interval_seconds": 150,
        "repetition_ratio_bps": 0, "regularity_score_bps": 5000,
        "evidence_timestamp": "2026-08-23T00:00:00Z",
    })


def test_deploy_evaluate_and_read_back_on_studionet():
    """Opt-in real-network path; this invokes actual GenLayer validators/LLM."""
    factory = get_contract_factory("ProofOfHumanityOracle")
    contract = factory.deploy(args=[])

    wallet = "0x2222222222222222222222222222222222222222"
    receipt = contract.evaluate_wallet(args=[wallet, canonical_evidence(wallet), True]).transact()
    assert tx_execution_succeeded(receipt), receipt

    record = json.loads(contract.get_humanity_status(args=[wallet]).call())
    assert record["evaluated"] is True
    assert record["wallet"] == wallet
    assert record["status"] in {"Human", "Unknown", "Sybil_Risk"}
    assert len(record["evidence_hash"]) == 64
