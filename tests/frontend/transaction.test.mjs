import test from "node:test";
import assert from "node:assert/strict";
import { assertSuccessfulFinalization, executionSucceeded, pollForFinalizedTransaction, PollingAbortedError } from "../../frontend/transaction.js";

test("successful transaction finalization is recognized", () => {
  const tx = { statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN" };
  assert.equal(executionSucceeded(tx), true);
  assert.equal(assertSuccessfulFinalization(tx), tx);
});

test("finalized execution failure is not reported as success", () => {
  assert.throws(() => assertSuccessfulFinalization({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_ERROR" }), /execution failure/);
});

test("polling continues through a long processing sequence", async () => {
  const statuses = ["PENDING", "PROPOSING", "COMMITTING", "REVEALING", "FINALIZED"];
  let reads = 0;
  const tx = await pollForFinalizedTransaction({ getTransaction: async () => ({ statusName: statuses[reads++] ?? "FINALIZED" }) }, "0xabc", { intervalMs: 0 });
  assert.equal(reads, 5);
  assert.equal(tx.statusName, "FINALIZED");
});

test("canceled transaction is a real failure", async () => {
  await assert.rejects(() => pollForFinalizedTransaction({ getTransaction: async () => ({ statusName: "CANCELED" }) }, "0xabc", { intervalMs: 0 }), /canceled/);
});

test("an RPC status failure is retried, not treated as transaction failure", async () => {
  let reads = 0;
  const tx = await pollForFinalizedTransaction({ getTransaction: async () => {
    if (reads++ === 0) throw new Error("temporary RPC outage");
    return { statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN" };
  } }, "0xrpc", { intervalMs: 0, retryBaseMs: 0, retryMaxMs: 0 });
  assert.equal(reads, 2);
});

test("multiple 502/network failures preserve the last state and eventually succeed", async () => {
  let reads = 0; const updates = [];
  const tx = await pollForFinalizedTransaction({ getTransaction: async () => {
    if (reads++ < 2) throw Object.assign(new Error("502 Bad Gateway"), { status: 502 });
    return { statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN" };
  } }, "0x502", { intervalMs: 0, retryBaseMs: 0, retryMaxMs: 0, onUpdate: (update) => updates.push(update) });
  assert.equal(tx.statusName, "FINALIZED");
  assert.equal(updates.filter((update) => update.retrying).length, 2);
  assert.ok(updates.every((update) => update.status === "PENDING" || update.status === "FINALIZED"));
});

test("polling timeout is distinct from finalized execution failure", async () => {
  await assert.rejects(() => pollForFinalizedTransaction({ getTransaction: async () => { throw new Error("502 Bad Gateway"); } }, "0xtimeout", { intervalMs: 0, retryBaseMs: 0, retryMaxMs: 0, maxDurationMs: 10, rpcRequestTimeoutMs: 5 }), (error) => error.code === "POLLING_TIMEOUT" && error.lastStatus === "PENDING");
});

test("duplicate polling requests share one in-flight loop", async () => {
  let reads = 0;
  const client = { getTransaction: async () => ({ statusName: reads++ ? "FINALIZED" : "PENDING" }) };
  const first = pollForFinalizedTransaction(client, "0xdedupe", { intervalMs: 0 });
  const second = pollForFinalizedTransaction(client, "0xdedupe", { intervalMs: 0 });
  assert.equal(first, second);
  await first;
  assert.equal(reads, 2);
});

test("polling can be stopped during page cleanup", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => pollForFinalizedTransaction({ getTransaction: async () => ({ statusName: "PENDING" }) }, "0xabort", { signal: controller.signal }), PollingAbortedError);
});
