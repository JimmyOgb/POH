import test from "node:test";
import assert from "node:assert/strict";
import { EVIDENCE_STATES, evidenceUiState, canSubmitEvidence } from "../../frontend/evidence-state.js";

const wallet = "0x1111111111111111111111111111111111111111";

test("connected Studionet wallet is ready to scan but not assess", () => {
  const ui = evidenceUiState({ walletReady: true, evidenceReady: false }, EVIDENCE_STATES.READY_TO_SCAN);
  assert.deepEqual(ui, { message: "Ready to scan", scanEnabled: true, assessmentEnabled: false });
});

test("disconnected and wrong-network states disable scanner and assessment", () => {
  for (const phase of [EVIDENCE_STATES.DISCONNECTED, EVIDENCE_STATES.CONNECTED_WRONG_NETWORK]) {
    const ui = evidenceUiState({ walletReady: false, evidenceReady: false }, phase);
    assert.equal(ui.scanEnabled, false);
    assert.equal(ui.assessmentEnabled, false);
  }
});

test("successful scan enables assessment and account change resets readiness", () => {
  assert.equal(evidenceUiState({ walletReady: true, evidenceReady: true }, EVIDENCE_STATES.SCAN_SUCCESS).assessmentEnabled, true);
  assert.equal(evidenceUiState({ walletReady: true, evidenceReady: false }, EVIDENCE_STATES.READY_TO_SCAN).assessmentEnabled, false);
});

test("stale evidence cannot be submitted for a different wallet", () => {
  assert.equal(canSubmitEvidence({ walletReady: true, evidenceReady: true, evidenceWallet: wallet, wallet, payload: "{}" }), true);
  assert.equal(canSubmitEvidence({ walletReady: true, evidenceReady: true, evidenceWallet: wallet, wallet: "0x2222222222222222222222222222222222222222", payload: "{}" }), false);
});

test("failed scan keeps assessment disabled", () => {
  assert.equal(evidenceUiState({ walletReady: true, evidenceReady: false }, EVIDENCE_STATES.READY_TO_SCAN).assessmentEnabled, false);
});

test("chain change to wrong network invalidates scanner state", () => {
  const ui = evidenceUiState({ walletReady: false, evidenceReady: false }, EVIDENCE_STATES.CONNECTED_WRONG_NETWORK);
  assert.equal(ui.message, "Switch to GenLayer Studionet");
  assert.equal(ui.scanEnabled, false);
});
