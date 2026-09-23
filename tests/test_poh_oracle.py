import importlib.util
import sys
import types
from pathlib import Path
import pytest


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


def sample_decision(score=85, reasoning="verified multi-day activity", ev_hash="0123456789abcdef" * 4, ev_status="verified_authoritative_rpc"):
    band = poh.score_band(score)
    return {
        "score": score,
        "score_band": band,
        "status": poh.status_for_band(band),
        "risk": poh.risk_for_band(band),
        "reasoning": reasoning,
        "evidence_status": ev_status,
        "evidence_hash": ev_hash,
    }


# ==============================================================================
# Rejection Item 2 & 10.A: Complete Consensus Agreement & Disagreement Tests
# ==============================================================================

def test_identical_complete_decision_objects_agree():
    lead = sample_decision(85, "reasoning a")
    val = sample_decision(85, "reasoning a")
    assert poh.consensus_agrees(lead, val) is True


def test_validator_score_disagreement_fails():
    """Regression test: even within the same band (81 vs 99), score disagreement must fail."""
    lead = sample_decision(81, "same reasoning")
    val = sample_decision(99, "same reasoning")
    assert poh.consensus_agrees(lead, val) is False


def test_validator_decision_status_disagreement_fails():
    lead = sample_decision(85)
    val = sample_decision(85)
    val["status"] = "Sybil_Risk"
    assert poh.consensus_agrees(lead, val) is False


def test_validator_reasoning_disagreement_fails():
    lead = sample_decision(85, "reasoning one")
    val = sample_decision(85, "reasoning different")
    assert poh.consensus_agrees(lead, val) is False


def test_validator_evidence_status_disagreement_fails():
    lead = sample_decision(85)
    val = sample_decision(85)
    val["evidence_status"] = "unverified"
    assert poh.consensus_agrees(lead, val) is False


def test_validator_evidence_hash_disagreement_fails():
    lead = sample_decision(85, ev_hash="a" * 64)
    val = sample_decision(85, ev_hash="b" * 64)
    assert poh.consensus_agrees(lead, val) is False


def test_validator_risk_disagreement_fails():
    lead = sample_decision(85)
    val = sample_decision(85)
    val["risk"] = "High"
    assert poh.consensus_agrees(lead, val) is False


# ==============================================================================
# Rejection Item 4 & 10.G: Demo Attestation Removed & Negative Tests
# ==============================================================================

def test_demo_attestation_completely_removed_from_contract():
    source = (Path(__file__).parents[1] / "contract" / "poh_oracle.py").read_text()
    assert "attestation_passed_demo" not in source
    assert "demo attestation" not in source.lower()
    assert "zk_" not in source


# ==============================================================================
# Rejection Item 3 & 10.B: Real Evidence Timestamp Tests
# ==============================================================================

def test_valid_iso_timestamp():
    assert poh.validate_evidence_timestamp("2026-09-23T18:00:00Z") == "2026-09-23T18:00:00Z"
    assert poh.validate_evidence_timestamp("2026-08-15T12:34:56.789+00:00") == "2026-08-15T12:34:56.789+00:00"


def test_valid_epoch_timestamp():
    assert poh.validate_evidence_timestamp("1790184361") == "1790184361"
    assert poh.validate_evidence_timestamp("1790184361.5") == "1790184361.5"


def test_empty_or_whitespace_timestamp_rejected():
    with pytest.raises(ValueError, match="evidence_timestamp cannot be empty"):
        poh.validate_evidence_timestamp("")
    with pytest.raises(ValueError, match="evidence_timestamp cannot be empty"):
        poh.validate_evidence_timestamp("   ")


def test_malformed_timestamp_rejected():
    with pytest.raises(ValueError, match="evidence_timestamp format is invalid"):
        poh.validate_evidence_timestamp("not-a-timestamp-at-all")
    with pytest.raises(ValueError, match="evidence_timestamp has invalid length"):
        poh.validate_evidence_timestamp("2026")


# ==============================================================================
# Rejection Item 1: Narrow Humanity Claims & Score Band Derivations
# ==============================================================================

def test_status_and_risk_derived_from_canonical_band():
    assert poh.status_for_band(poh.score_band(85)) == "Human"
    assert poh.risk_for_band(poh.score_band(85)) == "Low"

    assert poh.status_for_band(poh.score_band(75)) == "Unknown"
    assert poh.risk_for_band(poh.score_band(75)) == "Medium"

    assert poh.status_for_band(poh.score_band(55)) == "Unknown"
    assert poh.risk_for_band(poh.score_band(55)) == "Medium"

    assert poh.status_for_band(poh.score_band(12)) == "Sybil_Risk"
    assert poh.risk_for_band(poh.score_band(12)) == "High"


def test_boundary_scores_map_to_expected_bands_and_status():
    expected = {
        0: ("0-39", "Sybil_Risk", "High"), 39: ("0-39", "Sybil_Risk", "High"),
        40: ("40-69", "Unknown", "Medium"), 69: ("40-69", "Unknown", "Medium"),
        70: ("70-79", "Unknown", "Medium"), 79: ("70-79", "Unknown", "Medium"),
        80: ("80-100", "Human", "Low"), 100: ("80-100", "Human", "Low"),
    }
    for score, (band, status, risk) in expected.items():
        res = poh.canonical_analysis({"score": score, "reasoning": "test"})
        assert (res["score_band"], res["status"], res["risk"]) == (band, status, risk)


def test_malformed_llm_response_is_rejected():
    with pytest.raises(ValueError, match="score"):
        poh.canonical_analysis({"reasoning": "missing score"})
    with pytest.raises(ValueError, match="valid JSON"):
        poh.canonical_analysis("not json")
    with pytest.raises(ValueError, match="integer"):
        poh.canonical_analysis({"score": "abc"})


def test_assessment_prompt_is_evidence_only_and_narrows_humanity_claims():
    prompt = poh.build_assessment_prompt('{"transaction_count":0,"active_days":0}')
    assert "behavioral reputation evidence" in prompt
    assert "Do NOT infer biological humanity, real-world identity, personhood, or uniqueness" in prompt
    assert "Scoring Rubric" in prompt
    assert "0-39 (Sybil_Risk" in prompt
    assert "80-100 (Human" in prompt


# ==============================================================================
# Rejection Item 5 & 10.C/E: Evidence Canonicalization & Strong Anchors
# ==============================================================================

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


def test_canonicalization_is_deterministic_and_drops_unknown_fields():
    evidence = valid_evidence()
    evidence["untrusted_prose"] = "this says human"
    first = poh.canonicalize_evidence(VALID_WALLET, __import__("json").dumps(evidence))
    second = poh.canonicalize_evidence(VALID_WALLET, __import__("json").dumps(dict(reversed(list(evidence.items())))))
    assert first == second
    assert "untrusted_prose" not in first
    assert poh.evidence_hash(first) == poh.evidence_hash(second)


def test_derive_verified_metrics_from_studionet_computes_exact_anchors():
    txs = [
        {"from_address": VALID_WALLET, "to_address": "0x2222222222222222222222222222222222222222", "created_at": "2026-08-23T01:00:00Z", "hash": "0xaaa"},
        {"from_address": VALID_WALLET, "to_address": "0x3333333333333333333333333333333333333333", "created_at": "2026-08-23T02:00:00Z", "hash": "0xbbb"},
    ]
    verified = poh.derive_verified_metrics_from_studionet(VALID_WALLET, txs, snapshot_block=12345, snapshot_timestamp="2026-08-23T02:00:00Z")
    assert verified["transaction_count"] == 2
    assert verified["unique_contracts"] == 2
    assert verified["active_days"] == 1
    assert verified["wallet"] == VALID_WALLET.lower()
    assert verified["source"] == "genlayer_studionet_rpc"
    assert verified["chain_id"] == 61999
    assert verified["latest_tx_hash"] == "0xbbb"
    assert verified["snapshot_block"] == 12345
    assert verified["evidence_timestamp"] == "2026-08-23T02:00:00Z"


def test_canonical_evidence_binds_wallet_caller_and_provenance():
    txs = [{"from_address": VALID_WALLET, "to_address": "0x2222222222222222222222222222222222222222", "created_at": "2026-08-23T01:00:00Z", "hash": "0x111"}]
    verified = poh.derive_verified_metrics_from_studionet(VALID_WALLET, txs, snapshot_block=999)
    caller = "0x8888888888888888888888888888888888888888"
    canonical = poh.build_canonical_evidence(VALID_WALLET, caller, "delegated", verified, "unverified notes")
    assert canonical["wallet"] == VALID_WALLET.lower()
    assert canonical["authenticated_caller"] == caller.lower()
    assert canonical["authorization_mode"] == "delegated"
    assert canonical["provenance"]["retrieval_status"] == "verified_authoritative_rpc"
    assert canonical["provenance"]["network"] == "studionet"
    assert canonical["provenance"]["chain_id"] == 61999
    assert canonical["provenance"]["snapshot_block"] == 999
    assert canonical["unverified_context"] == "unverified notes"

    first_hash = poh.evidence_hash(canonical)
    canonical2 = poh.build_canonical_evidence(VALID_WALLET, caller, "delegated", verified, "different notes")
    assert first_hash != poh.evidence_hash(canonical2)
