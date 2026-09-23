export const CONTRACT_ADDRESS = "0x2c58E357ae3e76d4e90fbdADd416F938A0798593";

// Verified against the deployed schema-v2 Studionet contract on 2026-08-23.
export const CONTRACT_SCHEMA = Object.freeze({
  evaluate_wallet: Object.freeze({ args: ["string", "string", "bool"], readonly: false, returns: "any" }),
  revoke_status: Object.freeze({ args: ["string"], readonly: false, returns: "any" }),
  get_admin: Object.freeze({ args: [], readonly: true, returns: "string" }),
  get_evidence_schema_version: Object.freeze({ args: [], readonly: true, returns: "string" }),
  get_registry: Object.freeze({ args: [], readonly: true, returns: "string" }),
  get_humanity_status: Object.freeze({ args: ["string"], readonly: true, returns: "string" }),
  get_score: Object.freeze({ args: ["string"], readonly: true, returns: "string" }),
  get_status: Object.freeze({ args: ["string"], readonly: true, returns: "string" }),
  set_evaluator_authorization: Object.freeze({ args: ["string", "bool"], readonly: false, returns: "string" }),
  is_evaluator_authorized: Object.freeze({ args: ["string", "string"], readonly: true, returns: "bool" }),
});

const WALLET = /^0x[0-9a-fA-F]{40}$/;

export function buildEvaluateWalletArgs(walletAddress, canonicalEvidence, attestationPassedDemo) {
  const args = [String(walletAddress), String(canonicalEvidence), Boolean(attestationPassedDemo)];
  if (!WALLET.test(args[0])) throw new Error("A valid wallet address string is required.");
  if (!args[1].trim()) throw new Error("Canonical evidence is required.");
  if (typeof attestationPassedDemo !== "boolean") throw new Error("The demo attestation must be boolean.");
  return args;
}

export function assertEvaluateWalletArgs(args) {
  if (!Array.isArray(args) || args.length !== 3) throw new Error("evaluate_wallet requires exactly three arguments.");
  if (typeof args[0] !== "string") throw new Error("evaluate_wallet walletAddress must be a JavaScript string.");
  if (typeof args[1] !== "string") throw new Error("evaluate_wallet canonicalEvidence must be a JavaScript string.");
  if (typeof args[2] !== "boolean") throw new Error("evaluate_wallet attestationPassedDemo must be a JavaScript boolean.");
  return args;
}
