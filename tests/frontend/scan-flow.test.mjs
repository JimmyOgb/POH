import test from "node:test";
import assert from "node:assert/strict";
import { scanOutcome } from "../../frontend/scan-flow.js";

test("zero quick scan without a viable deeper strategy is limited but assessable", () => {
  assert.deepEqual(scanOutcome({ mode: "quick", transactionCount: 0, canSearchDeeper: false }), { hasActivity: false, recommendExtended: false, assessmentAllowed: true, limitedEvidence: false });
});

test("quick activity allows assessment immediately", () => {
  assert.equal(scanOutcome({ mode: "quick", transactionCount: 1 }).assessmentAllowed, true);
});

test("explicit extended zero scan permits limited evidence assessment", () => {
  const outcome = scanOutcome({ mode: "extended", transactionCount: 0 });
  assert.equal(outcome.assessmentAllowed, true);
  assert.equal(outcome.limitedEvidence, true);
  assert.equal(outcome.recommendExtended, false);
});
