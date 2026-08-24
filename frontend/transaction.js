const SUCCESS_STATUS = "FINALIZED";
const FAILED_STATUSES = new Set(["CANCELED", "CANCELLED", "FAILED", "REVERTED"]);
const inFlightPolls = new Map();

export class PollingAbortedError extends Error {
  constructor() { super("Transaction polling stopped because the page was closed."); this.name = "PollingAbortedError"; }
}

export class PollingTimeoutError extends Error {
  constructor(lastStatus = "PENDING", lastTransaction = null, lastError = null) {
    super("GenLayer RPC polling timed out before transaction finalization could be confirmed.");
    this.name = "PollingTimeoutError"; this.code = "POLLING_TIMEOUT"; this.lastStatus = lastStatus; this.transaction = lastTransaction; this.cause = lastError;
  }
}

function transactionStatus(tx) {
  return String(tx?.statusName ?? tx?.status ?? "PENDING").toUpperCase();
}

function wait(intervalMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PollingAbortedError());
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(new PollingAbortedError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, intervalMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function getTransactionWithTimeout(client, hash, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PollingAbortedError());
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("GenLayer RPC request timed out.")); } }, timeoutMs);
    const onAbort = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new PollingAbortedError()); } };
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => client.getTransaction({ hash })).then((value) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(value);
    }, (error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(error);
    });
  });
}

export function executionSucceeded(tx) {
  return String(tx?.txExecutionResultName ?? tx?.executionResultName ?? "").toUpperCase() === "FINISHED_WITH_RETURN";
}

async function poll(client, hash, { intervalMs, onUpdate, signal, maxDurationMs, rpcRequestTimeoutMs, retryBaseMs, retryMaxMs }) {
  const startedAt = Date.now();
  let retryDelayMs = retryBaseMs;
  let lastStatus = "PENDING";
  let lastTransaction = null;
  let lastRpcError = null;
  while (true) {
    if (signal?.aborted) throw new PollingAbortedError();
    if (Date.now() - startedAt >= maxDurationMs) throw new PollingTimeoutError(lastStatus, lastTransaction, lastRpcError);
    let tx;
    try {
      tx = await getTransactionWithTimeout(client, hash, Math.min(rpcRequestTimeoutMs, Math.max(1, maxDurationMs - (Date.now() - startedAt))), signal);
    } catch (error) {
      if (error instanceof PollingAbortedError) throw error;
      lastRpcError = error;
      if (Date.now() - startedAt >= maxDurationMs) throw new PollingTimeoutError(lastStatus, lastTransaction, error);
      onUpdate({ status: lastStatus, transaction: lastTransaction, retrying: true, error });
      const delay = Math.min(retryDelayMs, retryMaxMs, maxDurationMs - (Date.now() - startedAt));
      await wait(Math.max(0, delay), signal);
      retryDelayMs = Math.min(retryMaxMs, Math.max(retryBaseMs, retryDelayMs * 2 || retryBaseMs));
      continue;
    }
    const status = transactionStatus(tx);
    lastStatus = status; lastTransaction = tx; lastRpcError = null; retryDelayMs = retryBaseMs;
    onUpdate({ status, transaction: tx });
    if (status === SUCCESS_STATUS) return tx;
    if (FAILED_STATUSES.has(status)) throw new Error(`Transaction ${status.toLowerCase()}`);
    await wait(Math.min(intervalMs, Math.max(0, maxDurationMs - (Date.now() - startedAt))), signal);
  }
}

export function pollForFinalizedTransaction(client, hash, options = {}) {
  const existing = inFlightPolls.get(hash);
  if (existing) return existing;
  const settings = { intervalMs: 3000, maxDurationMs: 10 * 60 * 1000, rpcRequestTimeoutMs: 15000, retryBaseMs: 1000, retryMaxMs: 10000, onUpdate: () => {}, signal: undefined, ...options };
  const promise = poll(client, hash, settings).finally(() => {
    if (inFlightPolls.get(hash) === promise) inFlightPolls.delete(hash);
  });
  inFlightPolls.set(hash, promise);
  return promise;
}

export function assertSuccessfulFinalization(tx) {
  if (!executionSucceeded(tx)) {
    const detail = tx?.txExecutionResultName ?? tx?.executionResultName ?? "no execution result";
    throw new Error(`Transaction finalized with execution failure (${detail})`);
  }
  return tx;
}
