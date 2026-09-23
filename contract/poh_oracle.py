# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

"""GenLayer-consensus behavioral evidence and reputation oracle.

Evaluations are bound to authenticated caller authorization and authoritative
Studionet RPC transaction data before persisting a public reputation record.
User-supplied context is strictly quarantined as unverified and cannot establish
activity facts.
"""

from genlayer import *
import hashlib
import json
import re
import typing

WALLET_PATTERN = re.compile(r"^0x[0-9a-fA-F]{40}$")
MAX_EVIDENCE_LENGTH = 20_000
MAX_SCAN_BLOCKS = 5_000
MAX_ACTIVITY_DAYS = 3_650
MAX_INTERVALS = 256
MAX_DAILY_COUNTS = 366
EXPECTED_SCHEMA_VERSION = "2"
LEGACY_SCHEMA_VERSION = "1"
EXPECTED_CHAIN_ID = 61_999
EXPECTED_SOURCE = "genlayer_studionet_rpc"
STUDIONET_RPC_URL = "https://studio.genlayer.com/api"

SCORE_BAND_SYBIL = "0-39"
SCORE_BAND_REVIEW = "40-69"
SCORE_BAND_HUMAN_REVIEW = "70-79"
SCORE_BAND_HUMAN = "80-100"


def score_band(score: int) -> str:
    if score < 0 or score > 100:
        raise ValueError("score must be between 0 and 100")
    if score < 40:
        return SCORE_BAND_SYBIL
    if score < 70:
        return SCORE_BAND_REVIEW
    if score < 80:
        return SCORE_BAND_HUMAN_REVIEW
    return SCORE_BAND_HUMAN


def status_for_band(band: str) -> str:
    if band == SCORE_BAND_SYBIL:
        return "Sybil_Risk"
    if band in (SCORE_BAND_REVIEW, SCORE_BAND_HUMAN_REVIEW):
        return "Unknown"
    if band == SCORE_BAND_HUMAN:
        return "Human"
    raise ValueError("unknown score band")


def _parse_score(raw: typing.Any) -> int:
    try:
        score = int(str(raw).strip())
    except (TypeError, ValueError):
        raise gl.vm.UserError("[LLM_ERROR] score must be an integer")
    if score < 0 or score > 100:
        raise gl.vm.UserError("[LLM_ERROR] score must be between 0 and 100")
    return score


def canonical_analysis(raw: typing.Any) -> dict:
    """Normalize an answer to the only fields used for consensus."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw.replace("```json", "").replace("```", "").strip())
        except ValueError:
            raise gl.vm.UserError("[LLM_ERROR] response was not valid JSON")
    if not isinstance(raw, dict) or "score" not in raw:
        raise gl.vm.UserError("[LLM_ERROR] response must contain score")
    score = _parse_score(raw["score"])
    band = score_band(score)
    return {"score": score, "score_band": band, "status": status_for_band(band), "reasoning": str(raw.get("reasoning", ""))[:2_000]}


def consensus_agrees(leader: dict, validator: dict) -> bool:
    """Reasoning is explanatory metadata, not a consensus field."""
    return leader.get("score_band") == validator.get("score_band") and leader.get("status") == validator.get("status")


def build_assessment_prompt(canonical_evidence_str: str, unverified_context: str = "") -> str:
    """Build the evidence-only prompt shared by leader and validators."""
    context_section = ""
    if unverified_context:
        context_section = (
            "\n\n=== UNVERIFIED CALLER-SUPPLIED CONTEXT ===\n"
            + unverified_context
            + "\nNOTE: The caller context above is strictly UNVERIFIED. It must NEVER be used to establish "
            "facts such as transaction count, wallet age, protocol interactions, funding history, "
            "transaction timing, or activity volume."
        )

    return (
        "Evaluate only the observable behavioral evidence supplied in this canonical evidence object. "
        "Assess the quality and strength of the evidence's behavioral signal, not the identity of a person. "
        "Do not infer real-world identity, uniqueness, wallet ownership, cryptographic humanity, "
        "or facts not present in the object. Do not invent missing activity or treat self-asserted "
        "claims as verified facts.\n\n"
        "The coverage_type distinguishes indexed_history from block_range. For indexed_history, "
        "indexed transaction records are the observed source and no block range was downloaded. "
        "For block_range, only the explicitly reported bounded block interval was observed. "
        "Absence of matching activity means no activity was observed in that coverage, not that the wallet is inactive. "
        "Use only the measured transaction observations in the object, including transaction count, "
        "active days, application diversity, temporal distribution, repetition signals, and regularity "
        "signals. Penalize insufficient evidence, including small or empty samples, bounded/partial scans, and evidence that is "
        "insufficient to support a conclusion. Identify uncertainty. A high score means stronger "
        "human-like behavioral signal in this evidence; it does not prove humanity, identity, ownership, "
        "or uniqueness.\n\n"
        "Return JSON only with exactly these fields: {\"score\": integer 0-100, \"reasoning\": string}. "
        "Do not return status or risk; the contract derives those from score bands.\n\n"
        "Canonical behavioral evidence:\n"
        "=== VERIFIED STUDIONET EVIDENCE ===\n"
        + canonical_evidence_str
        + context_section
    )


def _require_int(value: typing.Any, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise gl.vm.UserError("[EXPECTED] " + field + " must be an integer")
    if value < minimum or value > maximum:
        raise gl.vm.UserError("[EXPECTED] " + field + " is out of range")
    return value


def canonicalize_evidence(wallet_address: str, evidence_payload: str) -> dict:
    """Validate and return canonical evidence format."""
    if not isinstance(evidence_payload, str) or not evidence_payload.strip():
        raise gl.vm.UserError("[EXPECTED] canonical_evidence cannot be empty")
    if len(evidence_payload) > MAX_EVIDENCE_LENGTH:
        raise gl.vm.UserError("[EXPECTED] canonical_evidence is too long")
    try:
        raw = json.loads(evidence_payload)
    except (TypeError, ValueError):
        raise gl.vm.UserError("[EXPECTED] canonical_evidence must be valid JSON")
    if not isinstance(raw, dict):
        raise gl.vm.UserError("[EXPECTED] canonical_evidence must be a JSON object")

    required = (
        "schema_version", "wallet", "chain_id", "source", "transaction_count", "active_days",
        "unique_contracts", "activity_intervals_seconds", "daily_activity_counts",
        "median_interval_seconds", "repetition_ratio_bps", "regularity_score_bps", "evidence_timestamp",
    )
    for field in required:
        if field not in raw:
            raise gl.vm.UserError("[EXPECTED] missing evidence field: " + field)

    schema_version = raw["schema_version"]
    if schema_version not in (LEGACY_SCHEMA_VERSION, EXPECTED_SCHEMA_VERSION):
        raise gl.vm.UserError("[EXPECTED] unsupported evidence schema_version")
    if not isinstance(raw["wallet"], str) or not WALLET_PATTERN.fullmatch(raw["wallet"]):
        raise gl.vm.UserError("[EXPECTED] evidence wallet must be a 20-byte 0x address")
    if raw["wallet"].lower() != wallet_address.lower():
        raise gl.vm.UserError("[EXPECTED] evidence wallet does not match wallet_address")
    if _require_int(raw["chain_id"], "chain_id", 1, 2**31) != EXPECTED_CHAIN_ID:
        raise gl.vm.UserError("[EXPECTED] evidence chain_id must be Studionet 61999")
    if raw["source"] != EXPECTED_SOURCE:
        raise gl.vm.UserError("[EXPECTED] unsupported evidence source")

    if schema_version == LEGACY_SCHEMA_VERSION:
        scan_method = "block_range"
        coverage_type = "block_range"
    else:
        for field in ("scan_method", "coverage_type"):
            if field not in raw:
                raise gl.vm.UserError("[EXPECTED] missing evidence field: " + field)
        scan_method = raw["scan_method"]
        coverage_type = raw["coverage_type"]
        if coverage_type not in ("block_range", "indexed_history"):
            raise gl.vm.UserError("[EXPECTED] unsupported evidence coverage_type")
        if coverage_type == "block_range" and scan_method != "block_range":
            raise gl.vm.UserError("[EXPECTED] block_range requires scan_method block_range")
        if coverage_type == "indexed_history" and scan_method != "address_index":
            raise gl.vm.UserError("[EXPECTED] indexed_history requires scan_method address_index")

    indexed_records = 0
    start = 0
    end = 0
    blocks = 0
    if coverage_type == "block_range":
        for field in ("scan_start_block", "scan_end_block", "blocks_scanned"):
            if field not in raw:
                raise gl.vm.UserError("[EXPECTED] missing evidence field: " + field)
        if "indexed_records" in raw:
            raise gl.vm.UserError("[EXPECTED] block_range cannot include indexed_records")
        start = _require_int(raw["scan_start_block"], "scan_start_block", 0, 2**63 - 1)
        end = _require_int(raw["scan_end_block"], "scan_end_block", 0, 2**63 - 1)
        blocks = _require_int(raw["blocks_scanned"], "blocks_scanned", 1, MAX_SCAN_BLOCKS)
        if start > end or end - start + 1 != blocks:
            raise gl.vm.UserError("[EXPECTED] scan block range is inconsistent")
    else:
        for field in ("scan_start_block", "scan_end_block", "blocks_scanned"):
            if field in raw:
                raise gl.vm.UserError("[EXPECTED] indexed_history must not include block range fields")
        indexed_records = _require_int(raw.get("indexed_records"), "indexed_records", 0, 100_000)

    transaction_count = _require_int(raw["transaction_count"], "transaction_count", 0, 100_000)
    active_days = _require_int(raw["active_days"], "active_days", 0, MAX_ACTIVITY_DAYS)
    unique_contracts = _require_int(raw["unique_contracts"], "unique_contracts", 0, transaction_count)
    if coverage_type == "indexed_history" and indexed_records < transaction_count:
        raise gl.vm.UserError("[EXPECTED] indexed_records cannot be below transaction_count")
    median_interval = _require_int(raw["median_interval_seconds"], "median_interval_seconds", 0, 31_536_000)
    repetition = _require_int(raw["repetition_ratio_bps"], "repetition_ratio_bps", 0, 10_000)
    regularity = _require_int(raw["regularity_score_bps"], "regularity_score_bps", 0, 10_000)

    intervals = raw["activity_intervals_seconds"]
    if not isinstance(intervals, list) or len(intervals) > MAX_INTERVALS:
        raise gl.vm.UserError("[EXPECTED] activity_intervals_seconds is invalid")
    normalized_intervals = [_require_int(value, "activity interval", 0, 31_536_000) for value in intervals]

    daily = raw["daily_activity_counts"]
    if not isinstance(daily, list) or len(daily) > MAX_DAILY_COUNTS:
        raise gl.vm.UserError("[EXPECTED] daily_activity_counts is invalid")
    normalized_daily = []
    daily_total = 0
    for value in daily:
        count = _require_int(value, "daily activity count", 0, 100_000)
        daily_total += count
        normalized_daily.append(count)
    if daily_total != transaction_count:
        raise gl.vm.UserError("[EXPECTED] daily activity counts do not match transaction_count")
    if active_days > len(normalized_daily):
        raise gl.vm.UserError("[EXPECTED] active_days exceeds daily activity range")
    if not isinstance(raw["evidence_timestamp"], str) or not raw["evidence_timestamp"].strip() or len(raw["evidence_timestamp"]) > 80:
        raise gl.vm.UserError("[EXPECTED] evidence_timestamp is invalid")

    canonical = {
        "schema_version": EXPECTED_SCHEMA_VERSION, "wallet": wallet_address.lower(), "chain_id": EXPECTED_CHAIN_ID,
        "source": EXPECTED_SOURCE, "scan_method": scan_method, "coverage_type": coverage_type,
        "transaction_count": transaction_count, "active_days": active_days, "unique_contracts": unique_contracts,
        "activity_intervals_seconds": normalized_intervals, "daily_activity_counts": normalized_daily,
        "median_interval_seconds": median_interval, "repetition_ratio_bps": repetition,
        "regularity_score_bps": regularity, "evidence_timestamp": raw["evidence_timestamp"],
    }
    if coverage_type == "block_range":
        canonical.update({"scan_start_block": start, "scan_end_block": end, "blocks_scanned": blocks})
    else:
        canonical["indexed_records"] = indexed_records
    return canonical


def canonical_evidence_json(evidence: dict) -> str:
    return json.dumps(evidence, sort_keys=True, separators=(",", ":"))


def evidence_hash(evidence: dict) -> str:
    return hashlib.sha256(canonical_evidence_json(evidence).encode("utf-8")).hexdigest()


def extract_unverified_context(raw_input: str) -> str:
    """Extract optional caller-supplied context, strictly quarantining it as unverified."""
    if not isinstance(raw_input, str) or not raw_input.strip():
        return ""
    text = raw_input.strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            for k in ("unverified_context", "user_context", "context", "notes", "description", "untrusted_prose"):
                if k in parsed and isinstance(parsed[k], str):
                    return parsed[k].strip()[:2_000]
            # If caller passed raw evidence object with unsupported prose
            if "untrusted_prose" in parsed:
                return str(parsed["untrusted_prose"])[:2_000]
    except Exception:
        pass
    return text[:2_000]


def derive_verified_metrics_from_studionet(target_wallet: str, tx_list: list) -> dict:
    """Derive canonical behavioral metrics strictly from authoritative Studionet transactions."""
    target_addr = target_wallet.lower()
    matching_txs = []
    for tx in tx_list:
        if isinstance(tx, dict) and str(tx.get("from_address", "")).lower() == target_addr:
            matching_txs.append(tx)

    tx_count = len(matching_txs)
    targets = [str(tx.get("to_address", "")).lower() for tx in matching_txs if tx.get("to_address")]
    unique_contracts = len(set(targets))

    timestamps = []
    days = []
    for tx in matching_txs:
        created_at = tx.get("created_at") or tx.get("created_timestamp") or tx.get("timestamp")
        if created_at is not None:
            ts_str = str(created_at)
            if len(ts_str) >= 10 and ts_str[4] == "-" and ts_str[7] == "-":
                days.append(ts_str[:10])
            try:
                ts_num = int(float(ts_str)) if ts_str.isdigit() or "." in ts_str else 0
                if ts_num > 0:
                    timestamps.append(ts_num)
            except Exception:
                pass

    timestamps.sort()
    intervals = []
    if len(timestamps) >= 2:
        for i in range(len(timestamps) - 1):
            diff = timestamps[i + 1] - timestamps[i]
            if diff >= 0:
                intervals.append(min(diff, 31_536_000))
    intervals = intervals[-MAX_INTERVALS:]

    median_interval = intervals[len(intervals) // 2] if intervals else 0
    unique_days = sorted(set(days))
    active_days = len(unique_days)

    daily_counts = []
    if unique_days:
        for day in unique_days:
            daily_counts.append(days.count(day))
    elif tx_count > 0:
        daily_counts = [tx_count]
        active_days = 1

    if daily_counts and sum(daily_counts) != tx_count:
        daily_counts = [tx_count]

    rep_ratio = max(0, min(10_000, int(((tx_count - unique_contracts) / tx_count) * 10_000))) if tx_count > 0 else 0

    regularity = 0
    if len(intervals) >= 2:
        mean_inv = sum(intervals) / len(intervals)
        if mean_inv > 0:
            dev = sum(abs(x - mean_inv) for x in intervals) / len(intervals)
            regularity = max(0, min(10_000, int(round(10_000 - (dev / mean_inv) * 10_000))))

    return {
        "schema_version": EXPECTED_SCHEMA_VERSION,
        "wallet": target_addr,
        "chain_id": EXPECTED_CHAIN_ID,
        "source": EXPECTED_SOURCE,
        "scan_method": "address_index",
        "coverage_type": "indexed_history",
        "indexed_records": len(tx_list),
        "transaction_count": tx_count,
        "active_days": min(active_days, MAX_ACTIVITY_DAYS),
        "unique_contracts": min(unique_contracts, tx_count),
        "activity_intervals_seconds": intervals,
        "daily_activity_counts": daily_counts[:MAX_DAILY_COUNTS],
        "median_interval_seconds": min(median_interval, 31_536_000),
        "repetition_ratio_bps": rep_ratio,
        "regularity_score_bps": regularity,
        "evidence_timestamp": "2026-09-23T07:11:14Z",
    }


def fetch_authoritative_studionet_evidence(target_wallet: str) -> dict:
    """Fetch real on-chain transaction activity for target_wallet from Studionet JSON-RPC.
    
    Fails closed if the source is unavailable, unreachable, or returns an error.
    Never uses fake, cached, or user-supplied activity metrics.
    """
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sim_getTransactionsForAddress",
        "params": [target_wallet],
    }
    headers = {"Content-Type": "application/json"}
    try:
        res = gl.nondet.web.post(
            STUDIONET_RPC_URL,
            body=json.dumps(payload).encode("utf-8"),
            headers=headers,
        )
    except Exception as e:
        raise gl.vm.UserError(f"[EXTERNAL] Failed to query Studionet RPC: {e}")

    if res.status != 200:
        raise gl.vm.UserError(f"[EXTERNAL] Studionet RPC returned HTTP {res.status}")

    body_bytes = res.body if res.body is not None else b""
    try:
        body_text = body_bytes.decode("utf-8") if isinstance(body_bytes, (bytes, bytearray)) else str(body_bytes)
        data = json.loads(body_text)
    except Exception:
        raise gl.vm.UserError("[EXTERNAL] Studionet RPC returned non-JSON response")

    if "error" in data:
        err = data["error"]
        msg = err.get("message", "") if isinstance(err, dict) else str(err)
        raise gl.vm.UserError(f"[EXTERNAL] Studionet RPC error: {msg}")

    tx_list = data.get("result")
    if not isinstance(tx_list, list):
        raise gl.vm.UserError("[EXTERNAL] Studionet RPC returned invalid result format")

    return derive_verified_metrics_from_studionet(target_wallet, tx_list)


def build_canonical_evidence(
    wallet: str,
    authenticated_caller: str,
    authorization_mode: str,
    verified_evidence: dict,
    unverified_context: str = "",
) -> dict:
    """Bind canonical evidence to chain, wallet, caller, authorization mode, and provenance."""
    canonical = {
        "schema_version": EXPECTED_SCHEMA_VERSION,
        "chain_id": EXPECTED_CHAIN_ID,
        "network": "studionet",
        "wallet": wallet.lower(),
        "authenticated_caller": authenticated_caller.lower(),
        "authorization_mode": authorization_mode,
        "source": EXPECTED_SOURCE,
        "scan_method": verified_evidence.get("scan_method", "address_index"),
        "coverage_type": verified_evidence.get("coverage_type", "indexed_history"),
        "transaction_count": verified_evidence["transaction_count"],
        "active_days": verified_evidence["active_days"],
        "unique_contracts": verified_evidence["unique_contracts"],
        "activity_intervals_seconds": verified_evidence["activity_intervals_seconds"],
        "daily_activity_counts": verified_evidence["daily_activity_counts"],
        "median_interval_seconds": verified_evidence["median_interval_seconds"],
        "repetition_ratio_bps": verified_evidence["repetition_ratio_bps"],
        "regularity_score_bps": verified_evidence["regularity_score_bps"],
        "evidence_timestamp": verified_evidence.get("evidence_timestamp", "2026-09-23T07:11:14Z"),
        "provenance": {
            "source": EXPECTED_SOURCE,
            "network": "studionet",
            "chain_id": EXPECTED_CHAIN_ID,
            "rpc_url": STUDIONET_RPC_URL,
            "method": "sim_getTransactionsForAddress",
            "authenticated_caller": authenticated_caller.lower(),
            "authorization_mode": authorization_mode,
            "retrieval_status": "verified_authoritative_rpc",
        },
    }
    if verified_evidence.get("coverage_type") == "block_range":
        canonical["scan_start_block"] = verified_evidence.get("scan_start_block")
        canonical["scan_end_block"] = verified_evidence.get("scan_end_block")
        canonical["blocks_scanned"] = verified_evidence.get("blocks_scanned")
    else:
        canonical["indexed_records"] = verified_evidence.get("indexed_records", verified_evidence["transaction_count"])

    if unverified_context:
        canonical["unverified_context"] = unverified_context
    return canonical


class ProofOfHumanityOracle(gl.Contract):
    state: TreeMap[str, str]
    registry: DynArray[str]

    def __init__(self):
        self.state["admin"] = str(gl.message.sender_address)

    def _validate_wallet(self, wallet_address: str) -> None:
        if not isinstance(wallet_address, str) or not WALLET_PATTERN.fullmatch(wallet_address):
            raise gl.vm.UserError("[EXPECTED] wallet_address must be a 20-byte 0x address")

    def _key(self, kind: str, addr: str) -> str:
        return kind + ":" + addr.lower()

    def _auth_key(self, authorizer: str, evaluator: str) -> str:
        return "auth:" + authorizer.lower() + ":" + evaluator.lower()

    def _is_evaluator_authorized(self, target_wallet: str, evaluator: str) -> bool:
        return self.state.get(self._auth_key(target_wallet, evaluator)) == "1"

    def _is_registered(self, addr: str) -> bool:
        return self._key("status", addr) in self.state

    def _remember(self, addr: str) -> None:
        if not self._is_registered(addr):
            self.registry.append(addr.lower())

    def _persist_evidence(self, addr: str, evidence: dict) -> None:
        self.state[self._key("evidence_hash", addr)] = evidence_hash(evidence)
        self.state[self._key("evidence_schema", addr)] = EXPECTED_SCHEMA_VERSION
        provenance = evidence.get("provenance", {})
        self.state[self._key("evidence_provenance", addr)] = json.dumps(provenance, sort_keys=True, separators=(",", ":"))
        self.state[self._key("evidence_summary", addr)] = json.dumps({
            "transaction_count": evidence["transaction_count"],
            "active_days": evidence["active_days"],
            "unique_contracts": evidence["unique_contracts"],
            "authenticated_caller": evidence.get("authenticated_caller", ""),
            "authorization_mode": evidence.get("authorization_mode", "self"),
        }, sort_keys=True, separators=(",", ":"))

    @gl.public.write
    def set_evaluator_authorization(self, evaluator_address: str, authorized: bool) -> str:
        """Allow a wallet owner to explicitly authorize or revoke a third-party evaluator."""
        self._validate_wallet(evaluator_address)
        owner = str(gl.message.sender_address).lower()
        evaluator = evaluator_address.lower()
        if owner == evaluator:
            raise gl.vm.UserError("[EXPECTED] cannot authorize self as evaluator")
        self.state[self._auth_key(owner, evaluator)] = "1" if authorized else "0"
        status_text = "authorized" if authorized else "revoked"
        return f"Evaluator {evaluator} {status_text} by {owner}."

    @gl.public.view
    def is_evaluator_authorized(self, wallet_address: str, evaluator_address: str) -> bool:
        self._validate_wallet(wallet_address)
        self._validate_wallet(evaluator_address)
        return self._is_evaluator_authorized(wallet_address, evaluator_address)

    @gl.public.write
    def evaluate_wallet(self, wallet_address: str, canonical_evidence: str, attestation_passed_demo: bool) -> typing.Any:
        """Assess authorized wallet using authoritative Studionet evidence after the demo gate."""
        self._validate_wallet(wallet_address)
        target = wallet_address.lower()
        caller = str(gl.message.sender_address).lower()

        # Phase 2: Caller authentication & authorization
        if caller == target:
            auth_mode = "self"
        elif self._is_evaluator_authorized(target, caller):
            auth_mode = "delegated"
        else:
            raise gl.vm.UserError("[EXPECTED] caller is not authorized to evaluate this wallet")

        # Quarantined caller context
        unverified_context = extract_unverified_context(canonical_evidence)

        # Demo attestation gate
        if not attestation_passed_demo:
            def fetch_demo_evidence() -> dict:
                verified = fetch_authoritative_studionet_evidence(target)
                return build_canonical_evidence(target, caller, auth_mode, verified, unverified_context)

            def validator_demo_evidence(leader_result: gl.vm.Result) -> bool:
                if not isinstance(leader_result, gl.vm.Return):
                    return False
                val_ev = fetch_demo_evidence()
                return val_ev == leader_result.calldata

            evidence = gl.vm.run_nondet_unsafe(fetch_demo_evidence, validator_demo_evidence)
            self._remember(target)
            self.state[self._key("score", target)] = "0"
            self.state[self._key("band", target)] = SCORE_BAND_SYBIL
            self.state[self._key("status", target)] = "Sybil_Risk"
            self.state[self._key("risk", target)] = "High"
            self.state[self._key("reasoning", target)] = "Demo attestation did not pass; behavioral evidence was not assessed as cryptographic verification."
            self.state[self._key("evaluated_by", target)] = caller
            self.state[self._key("evaluated_wallet", target)] = target
            self.state[self._key("authenticated_caller", target)] = caller
            self.state[self._key("authorization_mode", target)] = auth_mode
            self._persist_evidence(target, evidence)
            return "Demo attestation failed; wallet recorded as Sybil_Risk."

        # Consensus AI Evaluation
        def run_ai_evaluation() -> dict:
            verified = fetch_authoritative_studionet_evidence(target)
            ev = build_canonical_evidence(target, caller, auth_mode, verified, unverified_context)
            prompt = build_assessment_prompt(canonical_evidence_json(ev), unverified_context)
            analysis = canonical_analysis(gl.nondet.exec_prompt(prompt, response_format="json"))
            return {"analysis": analysis, "evidence": ev}

        def validator_fn(leader_result: gl.vm.Result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                return False
            validator_result = run_ai_evaluation()
            leader_analysis = leader_result.calldata.get("analysis", {})
            val_analysis = validator_result.get("analysis", {})
            return consensus_agrees(leader_analysis, val_analysis)

        nondet_result = gl.vm.run_nondet_unsafe(run_ai_evaluation, validator_fn)
        canonical = nondet_result["analysis"]
        evidence = nondet_result["evidence"]
        band = canonical["score_band"]

        self._remember(target)
        self.state[self._key("score", target)] = str(canonical["score"])
        self.state[self._key("band", target)] = band
        self.state[self._key("status", target)] = canonical["status"]
        self.state[self._key("risk", target)] = "High" if band == SCORE_BAND_SYBIL else ("Low" if band == SCORE_BAND_HUMAN else "Medium")
        self.state[self._key("reasoning", target)] = canonical["reasoning"]
        self.state[self._key("evaluated_by", target)] = caller
        self.state[self._key("evaluated_wallet", target)] = target
        self.state[self._key("authenticated_caller", target)] = caller
        self.state[self._key("authorization_mode", target)] = auth_mode
        self._persist_evidence(target, evidence)
        return "Wallet evaluated in canonical band " + band + " with status " + canonical["status"] + "."

    @gl.public.write
    def revoke_status(self, wallet_address: str) -> typing.Any:
        self._validate_wallet(wallet_address)
        if str(gl.message.sender_address).lower() != self.state["admin"].lower():
            raise gl.vm.UserError("[EXPECTED] only the contract admin can revoke statuses")
        if not self._is_registered(wallet_address):
            raise gl.vm.UserError("[EXPECTED] wallet has not been evaluated yet")
        addr = wallet_address.lower()
        self.state[self._key("score", addr)] = "0"
        self.state[self._key("band", addr)] = SCORE_BAND_SYBIL
        self.state[self._key("status", addr)] = "Sybil_Risk"
        self.state[self._key("risk", addr)] = "High"
        self.state[self._key("reasoning", addr)] = "Status manually revoked by admin."
        return "Status revoked for wallet: " + addr

    @gl.public.view
    def get_humanity_status(self, wallet_address: str) -> str:
        self._validate_wallet(wallet_address)
        addr = wallet_address.lower()
        if not self._is_registered(addr):
            return json.dumps({"evaluated": False, "wallet": addr})
        return json.dumps({
            "evaluated": True,
            "wallet": addr,
            "score": int(self.state[self._key("score", addr)]),
            "score_band": self.state[self._key("band", addr)],
            "status": self.state[self._key("status", addr)],
            "risk": self.state[self._key("risk", addr)],
            "reasoning": self.state[self._key("reasoning", addr)],
            "evaluated_by": self.state.get(self._key("evaluated_by", addr), ""),
            "evaluated_wallet": self.state.get(self._key("evaluated_wallet", addr), addr),
            "authenticated_caller": self.state.get(self._key("authenticated_caller", addr), self.state.get(self._key("evaluated_by", addr), "")),
            "authorization_mode": self.state.get(self._key("authorization_mode", addr), "self"),
            "evidence_hash": self.state[self._key("evidence_hash", addr)],
            "evidence_schema_version": self.state[self._key("evidence_schema", addr)],
            "evidence_provenance": json.loads(self.state.get(self._key("evidence_provenance", addr), "{}")),
            "evidence_summary": json.loads(self.state[self._key("evidence_summary", addr)]),
        })

    @gl.public.view
    def get_registry(self) -> str:
        records = []
        for addr in self.registry:
            records.append(json.loads(self.get_humanity_status(addr)))
        return json.dumps(records)

    @gl.public.view
    def get_score(self, wallet_address: str) -> str:
        self._validate_wallet(wallet_address)
        addr = wallet_address.lower()
        return self.state[self._key("score", addr)] if self._is_registered(addr) else "-1"

    @gl.public.view
    def get_status(self, wallet_address: str) -> str:
        self._validate_wallet(wallet_address)
        addr = wallet_address.lower()
        return self.state[self._key("status", addr)] if self._is_registered(addr) else "Not evaluated"

    @gl.public.view
    def get_admin(self) -> str:
        return self.state["admin"]

    @gl.public.view
    def get_evidence_schema_version(self) -> str:
        """Expose the canonical evidence version for frontend write gating."""
        return EXPECTED_SCHEMA_VERSION
