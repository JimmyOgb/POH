import importlib.util
import sys
import types
from pathlib import Path


class _Decorator:
    def __call__(self, function):
        return function


fake_gl = types.SimpleNamespace(
    Contract=object,
    public=types.SimpleNamespace(write=_Decorator(), view=_Decorator()),
    vm=types.SimpleNamespace(UserError=ValueError, Result=object, Return=object),
)
fake_genlayer = types.ModuleType("genlayer")
fake_genlayer.gl = fake_gl
fake_genlayer.TreeMap = dict
fake_genlayer.DynArray = list
_real_genlayer = sys.modules.get("genlayer")
sys.modules["genlayer"] = fake_genlayer


spec = importlib.util.spec_from_file_location("poh_oracle", Path(__file__).parents[1] / "contract" / "poh_oracle.py")
poh = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(poh)
finally:
    if _real_genlayer is None:
        sys.modules.pop("genlayer", None)
    else:
        sys.modules["genlayer"] = _real_genlayer


def result(score, reasoning):
    return poh.canonical_analysis({"score": score, "reasoning": reasoning})


def test_identical_status_with_different_reasoning_agrees():
    assert poh.consensus_agrees(result(85, "one"), result(85, "different"))


def test_scores_inside_same_band_agree():
    assert poh.consensus_agrees(result(81, "a"), result(99, "b"))


def test_disagreement_across_score_bands_fails():
    assert not poh.consensus_agrees(result(39, "a"), result(40, "b"))


def test_status_is_derived_from_canonical_band():
    assert poh.status_for_band(poh.score_band(85)) == "Human"
    assert poh.status_for_band(poh.score_band(55)) == "Unknown"
    assert poh.status_for_band(poh.score_band(12)) == "Sybil_Risk"
    assert poh.canonical_analysis({"score": 85, "status": "Sybil_Risk", "reasoning": "x"})["status"] == "Human"


def test_demo_attestation_naming_is_explicit():
    source = (Path(__file__).parents[1] / "contract" / "poh_oracle.py").read_text()
    assert "attestation_passed_demo" in source
    assert "zk_" not in source


def test_wallet_and_canonical_evidence_validation_reject_bad_inputs():
    contract = object.__new__(poh.ProofOfHumanityOracle)
    try:
        contract._validate_wallet("not-an-address")
        assert False, "invalid wallet should be rejected"
    except ValueError as error:
        assert "20-byte" in str(error)
    try:
        poh.canonicalize_evidence(VALID_WALLET, " ")
        assert False, "empty evidence should be rejected"
    except ValueError as error:
        assert "empty" in str(error)


def test_boundary_scores_map_to_expected_bands_and_status():
    expected = {
        0: ("0-39", "Sybil_Risk"), 39: ("0-39", "Sybil_Risk"),
        40: ("40-69", "Unknown"), 69: ("40-69", "Unknown"),
        70: ("70-79", "Unknown"), 79: ("70-79", "Unknown"),
        80: ("80-100", "Human"), 100: ("80-100", "Human"),
    }
    for score, (band, status) in expected.items():
        result = poh.canonical_analysis({"score": score, "reasoning": "test"})
        assert (result["score_band"], result["status"]) == (band, status)


def test_malformed_llm_response_is_rejected():
    import pytest

    with pytest.raises(ValueError, match="score"):
        poh.canonical_analysis({"reasoning": "missing score"})
    with pytest.raises(ValueError, match="valid JSON"):
        poh.canonical_analysis("not json")


def test_assessment_prompt_is_evidence_only_and_uncertainty_aware():
    prompt = poh.build_assessment_prompt('{"transaction_count":0,"active_days":0}')
    assert "quality and strength of the evidence" in prompt
    assert "Do not infer real-world identity" in prompt
    assert "uniqueness" in prompt
    assert "self-asserted" in prompt
    assert "measured transaction observations" in prompt
    assert "temporal distribution" in prompt
    assert "Penalize insufficient evidence" in prompt
    assert "Return JSON only" in prompt
    assert "canonical evidence object" in prompt
    assert "indexed_history" in prompt
    assert "block_range" in prompt
    assert "not that the wallet is inactive" in prompt


def test_validator_reruns_same_evidence_without_copying_leader_score():
    source = (Path(__file__).parents[1] / "contract" / "poh_oracle.py").read_text()
    assert "validator_result = run_ai_evaluation()" in source
    assert 'leader_result.calldata["score"]' not in source


def test_leader_and_validators_receive_identical_canonical_prompt():
    evidence_json = poh.canonical_evidence_json(poh.canonicalize_evidence(VALID_WALLET, __import__("json").dumps(indexed_evidence())))
    assert poh.build_assessment_prompt(evidence_json) == poh.build_assessment_prompt(evidence_json)
    assert "transaction_hashes" not in evidence_json


VALID_WALLET = "0x1111111111111111111111111111111111111111"


def valid_evidence():
    return {
        "schema_version": "1", "wallet": VALID_WALLET, "chain_id": 61999,
        "source": "genlayer_studionet_rpc", "scan_start_block": 10,
        "scan_end_block": 11, "blocks_scanned": 2, "transaction_count": 1,
        "active_days": 1, "unique_contracts": 1, "activity_intervals_seconds": [],
        "daily_activity_counts": [1], "median_interval_seconds": 0,
        "repetition_ratio_bps": 0, "regularity_score_bps": 0,
        "evidence_timestamp": "2026-08-23T00:00:00Z",
    }


def test_canonicalization_is_deterministic_and_drops_unknown_fields():
    evidence = valid_evidence()
    evidence["untrusted_prose"] = "this says human"
    first = poh.canonicalize_evidence(VALID_WALLET, __import__("json").dumps(evidence))
    second = poh.canonicalize_evidence(VALID_WALLET, __import__("json").dumps(dict(reversed(list(evidence.items())))))
    assert first == second
    assert "untrusted_prose" not in first
    assert poh.evidence_hash(first) == poh.evidence_hash(second)


def indexed_evidence(wallet=VALID_WALLET, **changes):
    value = {
        "schema_version": "2", "wallet": wallet, "chain_id": 61999,
        "source": "genlayer_studionet_rpc", "scan_method": "address_index",
        "coverage_type": "indexed_history", "indexed_records": 164, "transaction_count": 160,
        "active_days": 37, "unique_contracts": 73, "activity_intervals_seconds": [100, 200],
        "daily_activity_counts": [4] * 36 + [16], "median_interval_seconds": 150,
        "repetition_ratio_bps": 5000, "regularity_score_bps": 5000,
        "evidence_timestamp": "2026-08-23T00:00:00Z",
    }
    value.update(changes)
    return value


def test_indexed_history_canonicalization_has_no_fake_block_range():
    canonical = poh.canonicalize_evidence(VALID_WALLET, __import__("json").dumps(indexed_evidence()))
    assert canonical["schema_version"] == "2"
    assert canonical["scan_method"] == "address_index"
    assert canonical["coverage_type"] == "indexed_history"
    assert canonical["indexed_records"] == 164
    assert "scan_start_block" not in canonical
    assert "scan_end_block" not in canonical
    assert "blocks_scanned" not in canonical


def test_legacy_schema_one_block_range_is_migrated_to_schema_two():
    canonical = poh.canonicalize_evidence(VALID_WALLET, __import__("json").dumps(valid_evidence()))
    assert canonical["schema_version"] == "2"
    assert canonical["coverage_type"] == "block_range"
    assert canonical["scan_method"] == "block_range"
    assert canonical["blocks_scanned"] == 2


def test_indexed_history_rejects_block_metadata_and_impossible_counts():
    import pytest

    with pytest.raises(ValueError, match="must not include block range"):
        poh.canonicalize_evidence(VALID_WALLET, __import__("json").dumps(indexed_evidence(scan_start_block=1)))
    with pytest.raises(ValueError, match="below transaction_count"):
        poh.canonicalize_evidence(VALID_WALLET, __import__("json").dumps(indexed_evidence(indexed_records=1)))
