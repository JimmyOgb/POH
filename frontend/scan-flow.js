export function scanOutcome({ mode, transactionCount, completed = true, canSearchDeeper = false }) {
  const hasActivity = Number(transactionCount) > 0;
  const extended = mode === "extended";
  return {
    hasActivity,
    recommendExtended: !extended && !hasActivity && canSearchDeeper,
    assessmentAllowed: completed && (hasActivity || extended || !canSearchDeeper),
    limitedEvidence: extended && !hasActivity,
  };
}
