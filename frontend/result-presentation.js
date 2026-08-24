export function friendlyInterpretation(record = {}) {
  const score = Number(record.score);
  if (Number.isFinite(score) && score >= 80) return { label: "Strong behavioral evidence", tone: "human" };
  if (Number.isFinite(score) && score >= 40) return { label: "Moderate behavioral evidence", tone: "unknown" };
  if (Number.isFinite(score)) return { label: "Insufficient behavioral evidence", tone: "unknown" };
  return { label: "Behavioral evidence assessment", tone: "unknown" };
}

export function plainExplanation(record = {}, evidence = null) {
  if (evidence?.transaction_count === 0) {
    const coverage = evidence.scan_method === "address_index"
      ? "the indexed wallet history returned by Studionet"
      : "the selected block range";
    return `We couldn't find enough observable wallet activity in the scanned period to identify meaningful behavioral patterns. The scan found no observable activity in ${coverage}, so the LLM validators had no behavioral pattern to evaluate. This is a bounded portion of available history and does not establish that the wallet is inactive.`;
  }
  if (evidence) {
    const coverage = evidence.scan_method === "address_index"
      ? `${evidence.indexed_records ?? evidence.transaction_count} indexed wallet records`
      : `${evidence.blocks_scanned} scanned blocks`;
    return `The assessment is based on ${evidence.transaction_count} observed transaction${evidence.transaction_count === 1 ? "" : "s"} across ${coverage}. The validators evaluated the behavioral signals available in that evidence.`;
  }
  return record.reasoning || "The validators evaluated the behavioral evidence persisted for this wallet.";
}

export const RESULT_DISCLAIMER = "This assessment does not verify identity, wallet ownership, uniqueness, or personhood. A low score means the available behavioral evidence was insufficient or weak.";
