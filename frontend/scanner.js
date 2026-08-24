const WALLET = /^0x[0-9a-fA-F]{40}$/;
const MAX_SCAN_BLOCKS = 5000;
const MAX_INTERVALS = 256;
const DEFAULT_SCAN_TIMEOUT_MS = 30000;
const DEFAULT_RPC_TIMEOUT_MS = 10000;
const DEFAULT_SCAN_CONCURRENCY = 5;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_BATCH_CONCURRENCY = 2;
const DEFAULT_ADAPTIVE_RANGES = [50, 100, 250, 500, 1000, 2500, 5000];
const REQUIRED_EVIDENCE_FIELDS = [
  "schema_version", "wallet", "chain_id", "source", "scan_method", "coverage_type",
  "transaction_count", "active_days", "unique_contracts",
  "activity_intervals_seconds", "daily_activity_counts", "median_interval_seconds",
  "repetition_ratio_bps", "regularity_score_bps", "evidence_timestamp",
];

export class ScanTimeoutError extends Error {
  constructor(message = "Wallet scan timed out", timeoutSource = "unknown") { super(message); this.name = "ScanTimeoutError"; this.code = "SCAN_TIMEOUT"; this.timeoutSource = timeoutSource; }
}

export class ScanCancelledError extends Error {
  constructor() { super("Wallet scan cancelled."); this.name = "ScanCancelledError"; this.code = "SCAN_CANCELLED"; }
}

export class UnsupportedScannerMethodError extends Error {
  constructor(message) { super(message); this.name = "UnsupportedScannerMethodError"; this.code = "SCANNER_METHOD_UNSUPPORTED"; }
}

function isDevelopment() {
  return typeof location !== "undefined" && ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new ScanCancelledError();
}

function requestWithTimeout(operation, timeoutMs, signal, label, timeoutSource = label) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const requestController = new AbortController();
    const abortRequest = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); requestController.abort(); signal?.removeEventListener("abort", abortRequest); reject(new ScanCancelledError());
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; requestController.abort();
      reject(new ScanTimeoutError(`Wallet scan timed out waiting for ${label}.`, timeoutSource));
    }, timeoutMs);
    signal?.addEventListener("abort", abortRequest, { once: true });
    Promise.resolve().then(() => operation(requestController.signal)).then((value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abortRequest); resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); requestController.abort(); signal?.removeEventListener("abort", abortRequest);
      reject(signal?.aborted ? new ScanCancelledError() : error);
    });
  });
}

function withOverallTimeout(operation, timeoutMs, signal) {
  return requestWithTimeout((requestSignal) => operation(requestSignal), timeoutMs, signal, "the complete scan", "overall_scan_timeout");
}

function rpcEndpoint(client) {
  return client?.chain?.rpcUrls?.default?.http?.[0] || "";
}

function rpcOrigin(endpoint) {
  try { return new URL(endpoint).origin; } catch { return "unavailable"; }
}

async function fetchBlockBatch(endpoint, blockNumbers, timeoutMs, signal) {
  const requests = blockNumbers.map((number, index) => ({ jsonrpc: "2.0", id: index + 1, method: "eth_getBlockByNumber", params: [`0x${number.toString(16)}`, true] }));
  const startedAt = Date.now();
  const body = await requestWithTimeout(async (requestSignal) => {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requests), signal: requestSignal });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    return response.json();
  }, timeoutMs, signal, `block batch ${blockNumbers[0]}–${blockNumbers.at(-1)}`);
  if (!Array.isArray(body) || body.length !== blockNumbers.length) throw new Error("Studionet returned an invalid batched block response.");
  const errors = body.filter((item) => item?.error);
  if (errors.length) throw new Error(errors[0].error.message || "Studionet rejected a batched block request.");
  return { blocks: body.sort((a, b) => a.id - b.id).map((item) => item.result), bytes: JSON.stringify(body).length, elapsedMs: Date.now() - startedAt };
}

async function fetchAddressTransactions(endpoint, walletAddress, timeoutMs, signal, onDiagnostic) {
  const method = "sim_getTransactionsForAddress";
  const requestStartedAt = Date.now();
  const requestBody = { jsonrpc: "2.0", id: 1, method, params: [walletAddress] };
  onDiagnostic({ event: "request_start", scannerMethod: "address_index", rpcMethod: method, rpcUrl: endpoint, walletAddress, paramsShape: "[walletAddress]", timeoutMs, timeoutSource: "address_index_rpc_timeout" });
  try {
    const body = await requestWithTimeout(async (requestSignal) => {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody), signal: requestSignal });
      onDiagnostic({ event: "http_response", scannerMethod: "address_index", rpcMethod: method, rpcUrl: endpoint, httpStatus: response.status, responseDurationMs: Date.now() - requestStartedAt });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      return response.json();
    }, timeoutMs, signal, "address-indexed wallet activity", "address_index_rpc_timeout");
    if (body?.error) {
      onDiagnostic({ event: "rpc_error", scannerMethod: "address_index", rpcMethod: method, rpcUrl: endpoint, rpcErrorCode: body.error.code ?? null, rpcErrorMessage: body.error.message || "RPC error", responseDurationMs: Date.now() - requestStartedAt });
      if ([-32601, -32602].includes(body.error.code)) throw new UnsupportedScannerMethodError(body.error.message || "Studionet address-indexed activity is unavailable.");
      throw new Error(body.error.message || "Studionet rejected the wallet activity request.");
    }
    if (!Array.isArray(body?.result)) throw new Error("Studionet returned an invalid address-indexed activity response.");
    onDiagnostic({ event: "response_records", scannerMethod: "address_index", rpcMethod: method, rpcUrl: endpoint, returnedRecords: body.result.length, responseDurationMs: Date.now() - requestStartedAt });
    return { transactions: body.result, bytes: JSON.stringify(body).length };
  } catch (error) {
    onDiagnostic({ event: "request_error", scannerMethod: "address_index", rpcMethod: method, rpcUrl: endpoint, errorName: error?.name || "Error", errorMessage: error?.message || "Unknown error", timeoutSource: error?.timeoutSource || null, responseDurationMs: Date.now() - requestStartedAt });
    throw error;
  }
}

function asNumber(value, label) {
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Studionet returned an invalid ${label}.`);
  return number;
}

function blockTimestamp(block) {
  return asNumber(block?.timestamp ?? 0, "block timestamp");
}

function dateKey(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function regularityScore(intervals) {
  if (intervals.length < 2) return 0;
  const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  if (!mean) return 0;
  const deviation = intervals.reduce((sum, value) => sum + Math.abs(value - mean), 0) / intervals.length;
  return Math.max(0, Math.min(10000, Math.round(10000 - (deviation / mean) * 10000)));
}

function canonicalEvidence(wallet, start, end, transactions, timestamps, targets, now, {
  blocksScanned = end - start + 1,
  scanMethod = "block_range",
  coverageType = "block_range",
  indexedRecords = 0,
} = {}) {
  const sortedTimes = [...timestamps].sort((a, b) => a - b);
  const intervals = sortedTimes.slice(1).map((value, index) => value - sortedTimes[index]).filter((value) => value >= 0);
  const sampledIntervals = intervals.slice(-MAX_INTERVALS);
  const days = sortedTimes.map(dateKey);
  const uniqueDays = [...new Set(days)].sort();
  const daily = [];
  if (uniqueDays.length) {
    const first = new Date(`${uniqueDays[0]}T00:00:00Z`);
    const last = new Date(`${uniqueDays[uniqueDays.length - 1]}T00:00:00Z`);
    for (let cursor = first; cursor <= last; cursor = new Date(cursor.getTime() + 86400000)) {
      const key = cursor.toISOString().slice(0, 10);
      daily.push(days.filter((day) => day === key).length);
    }
  }
  const transactionCount = transactions.length;
  const uniqueTargets = new Set(targets.filter(Boolean));
  const repeated = transactionCount ? Math.round(((transactionCount - uniqueTargets.size) / transactionCount) * 10000) : 0;
  const evidence = {
    schema_version: "2",
    wallet: wallet.toLowerCase(),
    chain_id: 61999,
    source: "genlayer_studionet_rpc",
    transaction_count: transactionCount,
    active_days: uniqueDays.length,
    unique_contracts: uniqueTargets.size,
    activity_intervals_seconds: sampledIntervals,
    daily_activity_counts: daily,
    median_interval_seconds: sampledIntervals.length ? sampledIntervals[Math.floor(sampledIntervals.length / 2)] : 0,
    repetition_ratio_bps: Math.max(0, Math.min(10000, repeated)),
    regularity_score_bps: regularityScore(sampledIntervals),
    scan_method: scanMethod,
    coverage_type: coverageType,
    evidence_timestamp: now,
  };
  if (coverageType === "block_range") {
    evidence.scan_start_block = start;
    evidence.scan_end_block = end;
    evidence.blocks_scanned = blocksScanned;
  } else {
    evidence.indexed_records = indexedRecords;
  }
  return evidence;
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCanonical(value[key])]));
  return value;
}

export function validateCanonicalEvidence(evidence, walletAddress) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("The scanner returned an invalid evidence object.");
  const missing = REQUIRED_EVIDENCE_FIELDS.filter((field) => !(field in evidence));
  if (missing.length) throw new Error(`The scanned evidence is missing required fields: ${missing.join(", ")}.`);
  if (evidence.schema_version !== "2" || evidence.chain_id !== 61999 || evidence.source !== "genlayer_studionet_rpc") throw new Error("The scanned evidence does not match the deployed contract schema.");
  if (!["block_range", "indexed_history"].includes(evidence.coverage_type)) throw new Error("The scanned evidence has an unsupported coverage type.");
  if (evidence.coverage_type === "block_range") {
    if (evidence.scan_method !== "block_range" || !Number.isInteger(evidence.scan_start_block) || !Number.isInteger(evidence.scan_end_block) || !Number.isInteger(evidence.blocks_scanned) || evidence.blocks_scanned < 1 || evidence.scan_end_block - evidence.scan_start_block + 1 !== evidence.blocks_scanned) throw new Error("The scanned block-range evidence is inconsistent.");
  } else if (evidence.scan_method !== "address_index" || !Number.isInteger(evidence.indexed_records) || evidence.indexed_records < 0 || "scan_start_block" in evidence || "scan_end_block" in evidence || "blocks_scanned" in evidence || evidence.indexed_records < evidence.transaction_count) {
    throw new Error("The scanned indexed-history evidence is inconsistent.");
  }
  if (String(evidence.wallet).toLowerCase() !== String(walletAddress).toLowerCase()) throw new Error("The scanned evidence wallet does not match the connected wallet.");
  if (!Array.isArray(evidence.activity_intervals_seconds) || !Array.isArray(evidence.daily_activity_counts)) throw new Error("The scanned evidence contains invalid activity arrays.");
  const integerInRange = (value, minimum, maximum) => Number.isInteger(value) && value >= minimum && value <= maximum;
  if (!integerInRange(evidence.transaction_count, 0, 100000) || !integerInRange(evidence.active_days, 0, 3650) || !integerInRange(evidence.unique_contracts, 0, evidence.transaction_count) || !integerInRange(evidence.median_interval_seconds, 0, 31536000) || !integerInRange(evidence.repetition_ratio_bps, 0, 10000) || !integerInRange(evidence.regularity_score_bps, 0, 10000)) throw new Error("The scanned evidence contains an invalid numeric metric.");
  if (evidence.activity_intervals_seconds.length > 256 || evidence.activity_intervals_seconds.some((value) => !integerInRange(value, 0, 31536000))) throw new Error("The scanned evidence contains invalid activity intervals.");
  if (evidence.daily_activity_counts.length > 366 || evidence.daily_activity_counts.some((value) => !integerInRange(value, 0, 100000)) || evidence.daily_activity_counts.reduce((sum, value) => sum + value, 0) !== evidence.transaction_count || evidence.active_days > evidence.daily_activity_counts.length) throw new Error("The scanned evidence contains invalid daily activity counts.");
  if (typeof evidence.evidence_timestamp !== "string" || !evidence.evidence_timestamp.trim() || evidence.evidence_timestamp.length > 80) throw new Error("The scanned evidence contains an invalid timestamp.");
  return evidence;
}

export function serializeCanonicalEvidence(evidence, walletAddress) {
  const validated = validateCanonicalEvidence(evidence, walletAddress);
  return JSON.stringify(sortCanonical(validated));
}

export function validateCanonicalEvidencePayload(payload, walletAddress) {
  if (typeof payload !== "string" || payload.trim() === "") throw new Error("Cannot submit assessment: wallet scan did not produce canonical evidence.");
  let evidence;
  try { evidence = JSON.parse(payload); } catch { throw new Error("Cannot submit assessment: canonical evidence is not valid JSON."); }
  validateCanonicalEvidence(evidence, walletAddress);
  return payload;
}

export async function scanWalletActivity(client, walletAddress, {
  maxBlocks = MAX_SCAN_BLOCKS,
  now = new Date().toISOString(),
  scanTimeoutMs = DEFAULT_SCAN_TIMEOUT_MS,
  rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  concurrency = DEFAULT_SCAN_CONCURRENCY,
  batchSize = DEFAULT_BATCH_SIZE,
  batchConcurrency = DEFAULT_BATCH_CONCURRENCY,
  adaptiveRanges = DEFAULT_ADAPTIVE_RANGES,
  useAddressIndex = true,
  signal,
  onProgress = () => {},
  onDiagnostic = () => {},
} = {}) {
  if (!WALLET.test(walletAddress || "")) throw new Error("Enter a valid wallet address before scanning.");
  if (!client || typeof client.getBlockNumber !== "function" || (typeof client.getBlock !== "function" && !rpcEndpoint(client))) {
    throw new Error("Studionet wallet scanning is unavailable because the GenLayer RPC client lacks block history methods.");
  }
  const limit = Math.max(1, Math.min(MAX_SCAN_BLOCKS, Number(maxBlocks) || MAX_SCAN_BLOCKS));
  const startedAt = Date.now();
  const debug = (...args) => { if (isDevelopment()) console.debug("[wallet-scan]", ...args); };
    debug("scan started", { blocksRequested: limit });
    onDiagnostic({ event: "scan_start", scannerMethod: useAddressIndex ? "address_index_first" : "block_range_only", rpcUrl: rpcEndpoint(client), walletAddress, scanTimeoutMs, rpcTimeoutMs, timeoutSource: "overall_scan_timeout" });
  const scan = async (parentSignal) => {
    onProgress({ phase: "latest", completed: 0, total: limit });
    const latestStartedAt = Date.now();
    const end = asNumber(await requestWithTimeout((requestSignal) => client.getBlockNumber({ signal: requestSignal }), rpcTimeoutMs, parentSignal, "latest block number"), "latest block number");
    debug("getBlockNumber complete", { rpcMethod: "eth_blockNumber", latestBlock: end, elapsedMs: Date.now() - latestStartedAt });
    const fullStart = Math.max(0, end - limit + 1);
    const fullTotal = end - fullStart + 1;
    debug("latest block and range", { latestBlock: end, scanStartBlock: fullStart, scanEndBlock: end, blocksRequested: fullTotal });
    const transactions = [];
    const timestamps = [];
    const targets = [];
    const transactionHashes = [];
    let scanStart = end + 1;
    let total = 0;
    let completed = 0;
    let rpcRequests = 1;
    let rpcMethodCalls = 1;
    let rpcBytes = 0;
    const collectBlock = (block) => {
      if (!block || typeof block !== "object") throw new Error("Studionet returned an invalid block response.");
        const blockTransactions = Array.isArray(block?.transactions) ? block.transactions : [];
        for (const transaction of blockTransactions) {
          if (typeof transaction === "string") continue;
          const fromAddress = typeof transaction?.from_address === "string" ? transaction.from_address : "";
          if (fromAddress.toLowerCase() !== walletAddress.toLowerCase()) continue;
          transactions.push(transaction); timestamps.push(blockTimestamp(block));
          targets.push(transaction.to_address ? String(transaction.to_address).toLowerCase() : "");
          if (typeof transaction.hash === "string" && transaction.hash) transactionHashes.push(transaction.hash);
        }
    };
    const reportProgress = (target) => {
      onProgress({ completed, total: target, scanStartBlock: scanStart, scanEndBlock: end });
      if (completed === 1 || completed === target || completed % 250 === 0) debug("blocks completed", { completed, total: target });
    };
    const endpoint = rpcEndpoint(client);
    debug("rpc configuration", { chain: client?.chain?.name || client?.chain?.id || "unknown", rpcOrigin: rpcOrigin(endpoint), latestBlock: end, scanStartBlock: fullStart, scanEndBlock: end, blocksRequested: fullTotal });
    let adaptive = false;
    if (endpoint && typeof fetch === "function" && useAddressIndex) {
      onProgress({ phase: "indexed", completed: 0, total: 0, scanStartBlock: fullStart, scanEndBlock: end });
      const indexStartedAt = Date.now();
      try {
        const indexedResult = await fetchAddressTransactions(endpoint, walletAddress, rpcTimeoutMs, parentSignal, onDiagnostic);
        const indexedTransactions = indexedResult.transactions;
        const indexedMatches = indexedTransactions.filter((transaction) => typeof transaction?.from_address === "string" && transaction.from_address.toLowerCase() === walletAddress.toLowerCase());
        const indexedTimestamps = indexedMatches.map((transaction) => {
          const value = Date.parse(transaction.created_at || transaction.created_timestamp || "");
          return Number.isFinite(value) ? Math.floor(value / 1000) : null;
        }).filter((value) => value !== null);
        const indexedTargets = indexedMatches.map((transaction) => transaction.to_address ? String(transaction.to_address).toLowerCase() : "");
        const indexedHashes = indexedMatches.map((transaction) => transaction.hash).filter((hash) => typeof hash === "string" && hash);
        const evidence = validateCanonicalEvidence(canonicalEvidence(walletAddress, null, null, indexedMatches, indexedTimestamps, indexedTargets, now, {
          blocksScanned: 0,
          scanMethod: "address_index",
          coverageType: "indexed_history",
          indexedRecords: indexedTransactions.length,
        }), walletAddress);
        onDiagnostic({ event: "indexed_evidence_ready", scannerMethod: "address_index", coverageType: "indexed_history", returnedRecords: indexedTransactions.length, matchingRecords: indexedMatches.length, transactionCount: evidence.transaction_count, responseDurationMs: Date.now() - indexStartedAt });
        debug("address-indexed scan complete", { rpcMethod: "sim_getTransactionsForAddress", returnedTransactions: indexedTransactions.length, matchingTransactions: indexedMatches.length, elapsedMs: Date.now() - indexStartedAt });
        onProgress({ phase: "evidence", completed: 0, total: 0, scanStartBlock: 0, scanEndBlock: end });
        return {
          evidence,
          metrics: { transaction_count: evidence.transaction_count, active_days: evidence.active_days, unique_contracts: evidence.unique_contracts, median_interval_seconds: evidence.median_interval_seconds, repetition_ratio_bps: evidence.repetition_ratio_bps, regularity_score_bps: evidence.regularity_score_bps },
          scanStartBlock: null,
          scanEndBlock: null,
          blocksScanned: 0,
          transactionHashes: indexedHashes,
          rpcRequests: 2,
          rpcMethodCalls: 2,
          rpcBytes: indexedResult.bytes,
          adaptive: false,
        };
      } catch (error) {
        if (!(error instanceof UnsupportedScannerMethodError)) throw error;
        rpcRequests += 1;
        rpcMethodCalls += 1;
        debug("address-indexed method unavailable; using bounded block fallback", { message: error.message });
      }
    }
    if (endpoint && typeof fetch === "function") {
      adaptive = true;
      const ranges = [...new Set((Array.isArray(adaptiveRanges) ? adaptiveRanges : DEFAULT_ADAPTIVE_RANGES).map((value) => Math.max(1, Math.min(limit, Number(value) || limit))).concat(limit))].sort((a, b) => a - b);
      const size = Math.max(1, Math.min(100, Number(batchSize) || DEFAULT_BATCH_SIZE));
      const workers = Math.max(1, Math.min(5, Number(batchConcurrency) || DEFAULT_BATCH_CONCURRENCY));
      let currentTarget = 0;
      let averageBatchMs = 0;
      for (const target of ranges) {
        throwIfAborted(parentSignal);
        const targetStart = Math.max(0, end - target + 1);
        const numbers = Array.from({ length: scanStart - targetStart }, (_, index) => targetStart + index);
        if (!numbers.length) continue;
        const batches = [];
        for (let index = 0; index < numbers.length; index += size) batches.push(numbers.slice(index, index + size));
        const stageStarted = Date.now();
        let nextBatch = 0;
        const worker = async () => {
          while (true) {
            throwIfAborted(parentSignal);
            const batch = batches[nextBatch++];
            if (!batch) return;
            const result = await fetchBlockBatch(endpoint, batch, rpcTimeoutMs, parentSignal);
            debug("batched getBlockByNumber complete", { rpcMethod: "eth_getBlockByNumber", range: `${batch[0]}–${batch.at(-1)}`, blocks: result.blocks.length, bytes: result.bytes, elapsedMs: result.elapsedMs });
            rpcRequests += 1; rpcMethodCalls += result.blocks.length; rpcBytes += result.bytes;
            const filteringStartedAt = Date.now();
            result.blocks.forEach(collectBlock);
            debug("transaction filtering complete", { range: `${batch[0]}–${batch.at(-1)}`, elapsedMs: Date.now() - filteringStartedAt });
            completed += result.blocks.length;
            reportProgress(target);
          }
        };
        await Promise.all(Array.from({ length: Math.min(workers, batches.length) }, () => worker()));
        scanStart = targetStart; total = target; currentTarget = target;
        const stageDuration = Date.now() - stageStarted;
        const completedBatches = batches.length;
        averageBatchMs = averageBatchMs ? (averageBatchMs + stageDuration / completedBatches) / 2 : stageDuration / completedBatches;
        const nextTarget = ranges.find((value) => value > currentTarget);
        if (!nextTarget) break;
        const nextBatches = Math.ceil((nextTarget - currentTarget) / size);
        const estimatedNextMs = nextBatches * averageBatchMs / workers;
        if (Date.now() + estimatedNextMs > startedAt + scanTimeoutMs - 1000) { debug("adaptive range stopped by deadline", { currentTarget, nextTarget, estimatedNextMs }); break; }
      }
    } else {
      const start = fullStart;
      const totalBlocks = fullTotal;
      const concurrencyLimit = Math.max(1, Math.min(10, Number(concurrency) || DEFAULT_SCAN_CONCURRENCY));
      let nextIndex = 0;
      const worker = async () => {
        while (true) {
          throwIfAborted(parentSignal);
          const index = nextIndex++;
          if (index >= totalBlocks) return;
          const number = start + index;
          let block;
          try {
            block = await requestWithTimeout((requestSignal) => client.getBlock({ blockNumber: BigInt(number), includeTransactions: true, signal: requestSignal }), rpcTimeoutMs, parentSignal, `block ${number}`);
          } catch (error) {
            if (error?.code === "SCAN_TIMEOUT" || error?.code === "SCAN_CANCELLED") throw error;
            throw new Error(`Unable to read Studionet block ${number}: ${error?.message || "RPC request failed."}`);
          }
          collectBlock(block); completed += 1; scanStart = start; total = totalBlocks; reportProgress(totalBlocks); rpcRequests += 1; rpcMethodCalls += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrencyLimit, totalBlocks) }, () => worker()));
    }
    throwIfAborted(parentSignal);
    onProgress({ phase: "evidence", completed, total, scanStartBlock: scanStart, scanEndBlock: end });
    const evidenceStartedAt = Date.now();
    const evidence = validateCanonicalEvidence(canonicalEvidence(walletAddress, scanStart, end, transactions, timestamps, targets, now, {
      blocksScanned: total,
      scanMethod: "block_range",
      coverageType: "block_range",
      indexedRecords: 0,
    }), walletAddress);
    debug("evidence construction complete", { elapsedMs: Date.now() - evidenceStartedAt, evidenceLength: JSON.stringify(evidence).length, transactionCount: evidence.transaction_count });
    debug("scan completed", { strategy: adaptive ? "json-rpc-batch-adaptive" : "sdk-block-pool", blocksCompleted: completed, total, rpcRequests, rpcMethodCalls, rpcBytes, durationMs: Date.now() - startedAt });
    return {
      evidence,
      metrics: {
        transaction_count: evidence.transaction_count,
        active_days: evidence.active_days,
        unique_contracts: evidence.unique_contracts,
        median_interval_seconds: evidence.median_interval_seconds,
        repetition_ratio_bps: evidence.repetition_ratio_bps,
        regularity_score_bps: evidence.regularity_score_bps,
      },
      scanStartBlock: evidence.scan_start_block,
      scanEndBlock: evidence.scan_end_block,
      blocksScanned: evidence.blocks_scanned,
      transactionHashes,
      rpcRequests,
      rpcMethodCalls,
      rpcBytes,
      adaptive,
    };
  };
  return withOverallTimeout(scan, scanTimeoutMs, signal);
}

export { MAX_SCAN_BLOCKS };
