import test from "node:test";
import assert from "node:assert/strict";
import { friendlyInterpretation, plainExplanation, RESULT_DISCLAIMER } from "../../frontend/result-presentation.js";

test("score bands use behavioral interpretations", () => {
  assert.equal(friendlyInterpretation({ status: "Human", score: 80 }).label, "Strong behavioral evidence");
  assert.equal(friendlyInterpretation({ status: "Human", score: 100 }).label, "Strong behavioral evidence");
  assert.equal(friendlyInterpretation({ status: "Sybil_Risk", score: 79 }).label, "Moderate behavioral evidence");
  assert.equal(friendlyInterpretation({ status: "Sybil_Risk", score: 40 }).label, "Moderate behavioral evidence");
  assert.equal(friendlyInterpretation({ status: "Sybil_Risk", score: 0 }).label, "Insufficient behavioral evidence");
  assert.equal(friendlyInterpretation({ status: "Sybil_Risk", score: 39 }).label, "Insufficient behavioral evidence");
});

test("zero activity explanation uses actual evidence metrics", () => {
  const explanation = plainExplanation({ reasoning: "raw reasoning" }, { transaction_count: 0, blocks_scanned: 50 });
  assert.match(explanation, /no observable activity/);
  assert.match(explanation, /bounded portion/);
});

test("non-zero and missing optional data remain honest", () => {
  assert.match(plainExplanation({}, { transaction_count: 2, blocks_scanned: 50 }), /2 observed transactions/);
  assert.equal(plainExplanation({ reasoning: "Persisted contract explanation" }), "Persisted contract explanation");
  assert.equal(plainExplanation({}), "The validators evaluated the behavioral evidence persisted for this wallet.");
});

test("primary result disclaimer explicitly excludes identity and personhood claims", () => {
  assert.match(RESULT_DISCLAIMER, /identity/);
  assert.match(RESULT_DISCLAIMER, /uniqueness/);
  assert.match(RESULT_DISCLAIMER, /personhood/);
});
