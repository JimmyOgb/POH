export const EVIDENCE_STATES = Object.freeze({
  DISCONNECTED: "DISCONNECTED",
  CONNECTED_WRONG_NETWORK: "CONNECTED_WRONG_NETWORK",
  READY_TO_SCAN: "READY_TO_SCAN",
  SCANNING: "SCANNING",
  SCAN_SUCCESS: "SCAN_SUCCESS",
  ASSESSING: "ASSESSING",
  RESULT: "RESULT",
});

const MESSAGES = Object.freeze({
  [EVIDENCE_STATES.DISCONNECTED]: "Connect your wallet to scan",
  [EVIDENCE_STATES.CONNECTED_WRONG_NETWORK]: "Switch to GenLayer Studionet",
  [EVIDENCE_STATES.READY_TO_SCAN]: "Ready to scan",
  [EVIDENCE_STATES.SCANNING]: "Scanning wallet activity…",
  [EVIDENCE_STATES.SCAN_SUCCESS]: "Wallet activity detected",
  [EVIDENCE_STATES.ASSESSING]: "Assessment submitted",
  [EVIDENCE_STATES.RESULT]: "Assessment result recorded",
});

export function evidenceUiState(state, phase) {
  return {
    message: MESSAGES[phase],
    scanEnabled: Boolean(state.walletReady && [EVIDENCE_STATES.READY_TO_SCAN, EVIDENCE_STATES.SCAN_SUCCESS].includes(phase)),
    assessmentEnabled: Boolean(state.walletReady && state.evidenceReady && [EVIDENCE_STATES.SCAN_SUCCESS, EVIDENCE_STATES.RESULT].includes(phase)),
  };
}

export function canSubmitEvidence({ walletReady, evidenceReady, evidenceWallet, wallet, payload }) {
  return Boolean(walletReady && evidenceReady && payload && wallet && evidenceWallet === wallet.toLowerCase());
}
