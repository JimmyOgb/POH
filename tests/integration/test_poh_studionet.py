import json

import pytest
from gltest import get_contract_factory
from gltest.accounts import get_default_account
from gltest.assertions import tx_execution_succeeded


pytestmark = pytest.mark.slow


def test_deploy_evaluate_and_read_back_on_studionet():
    """Real-network path invoking actual GenLayer validators/LLM on Studionet."""
    account = get_default_account()
    wallet = account.address

    factory = get_contract_factory("ProofOfHumanityOracle")
    contract = factory.deploy(args=[])

    print(f"\n[STUDIONET DEPLOYMENT] Deployed ProofOfHumanityOracle at: {contract.address}")
    receipt = contract.evaluate_wallet(args=[wallet, ""]).transact()
    assert tx_execution_succeeded(receipt), receipt

    # 1-9: Verify all consensus-backed fields persisted on real Studionet
    record = json.loads(contract.get_humanity_status(args=[wallet]).call())
    assert record["evaluated"] is True
    assert record["wallet"].lower() == wallet.lower()
    assert record["status"] in {"Human", "Unknown", "Sybil_Risk"}
    assert record["score_band"] in {"80-100", "70-79", "40-69", "0-39"}
    assert record["risk"] in {"Low", "Medium", "High"}
    assert isinstance(record["score"], int)
    assert len(record["reasoning"]) > 0
    assert record["evidence_status"] == "verified_authoritative_rpc"
    assert len(record["evidence_hash"]) == 64
    assert record["authorization_mode"] == "self"
    assert record["authenticated_caller"].lower() == wallet.lower()
    assert record["evidence_provenance"]["retrieval_status"] == "verified_authoritative_rpc"
    assert record["evidence_provenance"]["network"] == "studionet"
    print(f"[STUDIONET VERIFIED] Status: {record['status']} (Band {record['score_band']}, Score {record['score']})")

    # 10-11: Attempt unauthorized evaluation of another wallet on real Studionet
    unauthorized_wallet = "0x1111111111111111111111111111111111111111"
    receipt_unauthorized = contract.evaluate_wallet(args=[unauthorized_wallet, ""]).transact()
    assert not tx_execution_succeeded(receipt_unauthorized), "Unauthorized evaluation must fail execution"
    unauthorized_status = json.loads(contract.get_humanity_status(args=[unauthorized_wallet]).call())
    assert unauthorized_status["evaluated"] is False, "Unauthorized wallet must never receive a verified reputation"
    print("[STUDIONET VERIFIED] Unauthorized evaluation fail-closed gate confirmed on-chain.")

