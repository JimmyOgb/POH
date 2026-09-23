export const CONTRACT_ADDRESS = "0x882E6E8A2Dd5061673716dB46f13EDf576a0E8aF";

// Contract API schema for GenLayer Studionet behavioral reputation oracle
export const CONTRACT_SCHEMA = Object.freeze({
  evaluate_wallet: Object.freeze({ args: ["string", "string"], readonly: false, returns: "string" }),
  revoke_status: Object.freeze({ args: ["string"], readonly: false, returns: "string" }),
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

export function buildEvaluateWalletArgs(walletAddress, canonicalEvidence) {
  const args = [String(walletAddress), String(canonicalEvidence)];
  if (!WALLET.test(args[0])) throw new Error("A valid wallet address string is required.");
  if (!args[1].trim()) throw new Error("Canonical evidence is required.");
  return args;
}

export function assertEvaluateWalletArgs(args) {
  if (!Array.isArray(args) || args.length !== 2) throw new Error("evaluate_wallet requires exactly two arguments.");
  if (typeof args[0] !== "string") throw new Error("evaluate_wallet walletAddress must be a JavaScript string.");
  if (typeof args[1] !== "string") throw new Error("evaluate_wallet canonicalEvidence must be a JavaScript string.");
  return args;
}
