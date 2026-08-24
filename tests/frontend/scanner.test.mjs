import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { scanWalletActivity, serializeCanonicalEvidence, validateCanonicalEvidencePayload } from "../../frontend/scanner.js";

const wallet = "0x1111111111111111111111111111111111111111";

test("scanner builds canonical evidence from real block transactions", async () => {
  const calls = [];
  const client = {
    getBlockNumber: async () => 101n,
    getBlock: async ({ blockNumber, includeTransactions }) => {
      calls.push({ blockNumber, includeTransactions });
      return {
        timestamp: blockNumber === 100n ? 1000n : 1120n,
        transactions: blockNumber === 100n ? [{ from_address: wallet.toUpperCase(), to_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", hash: "0xaaa" }, { from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", to_address: wallet, hash: "0xbbb" }] : [{ from_address: wallet, to_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", hash: "0xccc" }],
      };
    },
  };
  const scan = await scanWalletActivity(client, wallet, { maxBlocks: 2, now: "2026-08-23T00:00:00Z" });
  const evidence = scan.evidence;
  assert.equal(evidence.transaction_count, 2);
  assert.equal(evidence.unique_contracts, 2);
  assert.equal(evidence.blocks_scanned, 2);
  assert.deepEqual(scan.transactionHashes, ["0xaaa", "0xccc"]);
  assert.equal(evidence.coverage_type, "block_range");
  assert.deepEqual(evidence.daily_activity_counts, [2]);
  assert.deepEqual(evidence.activity_intervals_seconds, [120]);
  assert.equal(evidence.median_interval_seconds, 120);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.includeTransactions === true));
  assert.equal(JSON.parse(serializeCanonicalEvidence(evidence, wallet)).wallet, wallet);
  assert.equal(scan.scanStartBlock, 100);
  assert.equal(scan.scanEndBlock, 101);
  assert.equal(scan.blocksScanned, 2);
  assert.ok(serializeCanonicalEvidence(evidence, wallet).length > 0);
});

test("Studionet fields drive metrics, destination extraction, hashes, and malformed records safely", async () => {
  const client = {
    getBlockNumber: async () => 12n,
    getBlock: async ({ blockNumber }) => ({
      timestamp: blockNumber === 10n ? 1000n : 1120n,
      transactions: blockNumber === 10n
        ? [{ from_address: wallet.toUpperCase(), to_address: null, hash: "0xone" }, null, { from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", to_address: wallet, hash: "0xignored" }]
        : blockNumber === 11n
          ? [{ from_address: wallet, to_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", hash: "0xtwo" }, { from_address: wallet, to_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", hash: "0xthree" }]
          : [{ from_address: "not-an-address", to_address: "0xdead", hash: "0xignored" }, { from: wallet, to: "0xlegacy", hash: "0xlegacy" }],
    }),
  };
  const scan = await scanWalletActivity(client, wallet, { maxBlocks: 3 });
  const evidence = scan.evidence;
  assert.equal(evidence.transaction_count, 3);
  assert.equal(evidence.active_days, 1);
  assert.equal(evidence.unique_contracts, 1);
  assert.deepEqual(scan.transactionHashes, ["0xone", "0xtwo", "0xthree"]);
  assert.deepEqual(evidence.activity_intervals_seconds, [120, 0]);
  assert.equal(evidence.median_interval_seconds, 0);
  assert.deepEqual(evidence.daily_activity_counts, [3]);
  assert.equal(evidence.repetition_ratio_bps, 6667);
  assert.equal(evidence.regularity_score_bps, 0);
});

test("legacy from/to fields are not treated as valid Studionet activity", async () => {
  const client = { getBlockNumber: async () => 10n, getBlock: async () => ({ timestamp: 1000n, transactions: [{ from: wallet, to: "0xlegacy", hash: "0xlegacy" }] }) };
  const scan = await scanWalletActivity(client, wallet, { maxBlocks: 1 });
  const evidence = scan.evidence;
  assert.equal(evidence.transaction_count, 0);
  assert.deepEqual(scan.transactionHashes, []);
});

test("known transaction is outside quick range but detected by the explicit 500-block range", async () => {
  const knownBlock = 1787481401;
  const latest = 1787481680;
  const knownWallet = "0xe4220c4b71877bb94EB173f467ef5c5557017085";
  const knownHash = "0xb88c992eadcf2bdd3b7dc878b0dc0bbbef6947b925297cc2d98a63abffb9bfdd";
  const client = {
    getBlockNumber: async () => BigInt(latest),
    getBlock: async ({ blockNumber }) => ({ timestamp: 1000n, transactions: Number(blockNumber) === knownBlock ? [{ from_address: knownWallet.toUpperCase(), to_address: "0xd5105454404A2e960d26dfB8445CB50791727C79", hash: knownHash }] : [] }),
  };
  const quickScan = await scanWalletActivity(client, knownWallet, { maxBlocks: 50 });
  const quick = quickScan.evidence;
  assert.equal(quick.transaction_count, 0);
  const extendedScan = await scanWalletActivity(client, knownWallet, { maxBlocks: 500 });
  const extended = extendedScan.evidence;
  assert.equal(extended.transaction_count, 1);
  assert.deepEqual(extendedScan.transactionHashes, [knownHash]);
  assert.equal(extended.unique_contracts, 1);
});

test("canonical evidence rejects missing deployed-contract fields", () => {
  assert.throws(() => serializeCanonicalEvidence({ wallet }, wallet), /missing required fields/);
});

test("scanner reports empty history without fabricating activity", async () => {
  const client = { getBlockNumber: async () => 10n, getBlock: async () => ({ timestamp: 1000n, transactions: [] }) };
  const evidence = (await scanWalletActivity(client, wallet, { maxBlocks: 1, now: "2026-08-23T00:00:00Z" })).evidence;
  assert.equal(evidence.transaction_count, 0);
  assert.equal(evidence.active_days, 0);
  assert.deepEqual(evidence.daily_activity_counts, []);
});

test("scanner fails when block history is unavailable", async () => {
  await assert.rejects(() => scanWalletActivity({}, wallet), /lacks block history methods/);
});

test("RPC failure never becomes empty evidence", async () => {
  const client = { getBlockNumber: async () => 10n, getBlock: async () => { throw new Error("RPC unavailable"); } };
  await assert.rejects(() => scanWalletActivity(client, wallet, { maxBlocks: 1 }), /Unable to read Studionet block/);
});

test("scan reports real block progress and uses bounded concurrency", async () => {
  let active = 0;
  let peak = 0;
  const progress = [];
  const client = {
    getBlockNumber: async () => 149n,
    getBlock: async ({ blockNumber }) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { timestamp: 1000n, transactions: [] };
    },
  };
  const scan = await scanWalletActivity(client, wallet, { maxBlocks: 50, concurrency: 5, onProgress: (value) => progress.push(value.completed) });
  assert.equal(scan.blocksScanned, 50);
  assert.ok(peak <= 5);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
  assert.equal(progress.at(-1), 50);
});

test("getBlock request timeout rejects instead of hanging", async () => {
  const client = { getBlockNumber: async () => 10n, getBlock: async () => new Promise(() => {}) };
  await assert.rejects(() => scanWalletActivity(client, wallet, { maxBlocks: 1, rpcTimeoutMs: 10, scanTimeoutMs: 100 }), (error) => error.code === "SCAN_TIMEOUT");
});

test("getBlockNumber timeout rejects instead of hanging", async () => {
  const client = { getBlockNumber: async () => new Promise(() => {}), getBlock: async () => ({ timestamp: 1000n, transactions: [] }) };
  await assert.rejects(() => scanWalletActivity(client, wallet, { rpcTimeoutMs: 10, scanTimeoutMs: 100 }), (error) => error.code === "SCAN_TIMEOUT");
});

test("overall scan timeout bounds a slow block sequence", async () => {
  const client = { getBlockNumber: async () => 20n, getBlock: async () => new Promise((resolve) => setTimeout(() => resolve({ timestamp: 1000n, transactions: [] }), 50)) };
  await assert.rejects(() => scanWalletActivity(client, wallet, { maxBlocks: 20, concurrency: 1, rpcTimeoutMs: 1000, scanTimeoutMs: 20 }), (error) => error.code === "SCAN_TIMEOUT");
});

test("one failed block rejects the complete scan", async () => {
  const client = { getBlockNumber: async () => 10n, getBlock: async () => { throw new Error("HTTP 503"); } };
  await assert.rejects(() => scanWalletActivity(client, wallet, { maxBlocks: 1 }), /Unable to read Studionet block/);
});

test("cancellation rejects and does not produce evidence", async () => {
  const controller = new AbortController();
  const client = {
    getBlockNumber: async () => 10n,
    getBlock: async ({ signal }) => new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }),
  };
  const pending = scanWalletActivity(client, wallet, { maxBlocks: 1, signal: controller.signal, rpcTimeoutMs: 1000, scanTimeoutMs: 1000 });
  controller.abort();
  await assert.rejects(() => pending, (error) => error.code === "SCAN_CANCELLED");
});

test("payload validation rejects empty and malformed evidence", () => {
  assert.throws(() => validateCanonicalEvidencePayload("", wallet), /did not produce canonical evidence/);
  assert.throws(() => validateCanonicalEvidencePayload("{}", wallet), /missing required fields/);
});

function batchedClient({ fail = false, delayMs = 0, activity = true } = {}) {
  const calls = [];
  const client = {
    chain: { rpcUrls: { default: { http: ["https://studionet.example/api"] } } },
    getBlockNumber: async () => 105n,
  };
  const fetchImpl = async (_url, options) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const requests = JSON.parse(options.body);
    if (!Array.isArray(requests)) return { ok: true, json: async () => ({ error: { code: -32601, message: "Method not found" } }) };
    calls.push(requests);
    if (fail) return { ok: true, json: async () => requests.map((request) => ({ jsonrpc: "2.0", id: request.id, error: { message: "RPC unavailable" } })) };
    return {
      ok: true,
      json: async () => requests.map((request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          timestamp: "0x3e8",
          transactions: activity && Number.parseInt(request.params[0], 16) === 104
            ? [{ from_address: wallet.toUpperCase(), to_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", hash: "0xbatched" }, { from_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", to_address: wallet, hash: "0xignored" }]
            : [],
        },
      })),
    };
  };
  return { client, fetchImpl, calls };
}

test("address-indexed Studionet activity is preferred and preserves sender, destination, and hash", async () => {
  const originalFetch = globalThis.fetch;
  const indexedWallet = "0xe4220c4b71877bb94EB173f467ef5c5557017085";
  const knownHash = "0xb88c992eadcf2bdd3b7dc878b0dc0bbbef6947b925297cc2d98a63abffb9bfdd";
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === "sim_getTransactionsForAddress") return { ok: true, json: async () => ({ result: [{ hash: knownHash, from_address: indexedWallet.toUpperCase(), to_address: "0xd5105454404A2e960d26dfB8445CB50791727C79", created_at: "2026-08-23T10:36:28.604444Z" }] }) };
    throw new Error("unexpected block request");
  };
  try {
    const client = { chain: { rpcUrls: { default: { http: ["https://studionet.example/api"] } } }, getBlockNumber: async () => 1787481680n };
    const scan = await scanWalletActivity(client, indexedWallet, { maxBlocks: 50 });
    assert.equal(scan.evidence.scan_method, "address_index");
    assert.equal(scan.blocksScanned, 0);
    assert.ok(!("blocks_scanned" in scan.evidence));
    assert.equal(scan.evidence.transaction_count, 1);
    assert.deepEqual(scan.transactionHashes, [knownHash]);
    assert.equal(scan.evidence.coverage_type, "indexed_history");
    assert.equal(scan.evidence.indexed_records, 1);
    assert.equal(scan.evidence.unique_contracts, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("malformed indexed records are excluded without becoming activity", async () => {
  const originalFetch = globalThis.fetch;
  const indexedWallet = "0xe4220c4b71877bb94EB173f467ef5c5557017085";
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === "sim_getTransactionsForAddress") return { ok: true, json: async () => ({ result: [null, {}, { from: indexedWallet, to_address: "0xlegacy", hash: "0xlegacy" }, { from_address: indexedWallet.toUpperCase(), to_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", hash: "0xvalid", created_at: "2026-08-01T00:00:00Z" }] }) };
    throw new Error("unexpected block request");
  };
  try {
    const scan = await scanWalletActivity({ chain: { rpcUrls: { default: { http: ["https://studionet.example/api"] } } }, getBlockNumber: async () => 10n }, indexedWallet, { maxBlocks: 50 });
    assert.equal(scan.evidence.transaction_count, 1);
    assert.equal(scan.evidence.indexed_records, 4);
    assert.deepEqual(scan.transactionHashes, ["0xvalid"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("JSON-RPC batching scans real block ranges and filters wallet-originated activity", async () => {
  const originalFetch = globalThis.fetch;
  const { client, fetchImpl, calls } = batchedClient();
  globalThis.fetch = fetchImpl;
  try {
    const progress = [];
    const scan = await scanWalletActivity(client, wallet, {
      maxBlocks: 4,
      batchSize: 2,
      batchConcurrency: 1,
      adaptiveRanges: [2, 4],
      onProgress: (value) => progress.push(value),
      now: "2026-08-23T00:00:00Z",
    });
    assert.equal(scan.adaptive, true);
    assert.equal(scan.blocksScanned, 4);
    assert.equal(scan.evidence.transaction_count, 1);
    assert.equal(scan.evidence.scan_start_block, 102);
    assert.equal(scan.evidence.scan_end_block, 105);
    assert.equal(scan.evidence.blocks_scanned, 4);
    assert.equal(scan.rpcRequests, 4); // latest + unsupported index probe + two HTTP batches
    assert.equal(scan.rpcMethodCalls, 6); // latest + index probe + four block reads
    assert.ok(scan.rpcBytes > 0);
    assert.equal(progress.at(-1).completed, 4);
    assert.equal(calls.flat().length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("batched zero-activity scan produces non-empty canonical evidence", async () => {
  const originalFetch = globalThis.fetch;
  const { client, fetchImpl } = batchedClient({ activity: false });
  globalThis.fetch = fetchImpl;
  try {
    const scan = await scanWalletActivity(client, wallet, { maxBlocks: 2, adaptiveRanges: [2], batchSize: 2 });
    assert.equal(scan.evidence.transaction_count, 0);
    assert.ok(scan.evidence.blocks_scanned === 2);
    assert.ok(JSON.stringify(scan.evidence).length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("batched RPC errors reject without producing empty evidence", async () => {
  const originalFetch = globalThis.fetch;
  const { client, fetchImpl } = batchedClient({ fail: true });
  globalThis.fetch = fetchImpl;
  try {
    await assert.rejects(() => scanWalletActivity(client, wallet, { maxBlocks: 2, adaptiveRanges: [2], batchSize: 2 }), /RPC unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("160 indexed transactions produce compact deterministic behavioral evidence", async () => {
  const indexedWallet = "0xe4220c4b71877bb94EB173f467ef5c5557017085";
  const records = Array.from({ length: 160 }, (_, index) => ({
    hash: `0x${String(index).padStart(64, "0")}`,
    from_address: indexedWallet.toUpperCase(),
    to_address: index % 3 ? "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : "0xcccccccccccccccccccccccccccccccccccccc",
    created_at: `2026-07-${String(1 + (index % 28)).padStart(2, "0")}T12:00:00.000Z`,
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === "sim_getTransactionsForAddress") return { ok: true, json: async () => ({ result: records }) };
    throw new Error("unexpected block request");
  };
  try {
    const scan = await scanWalletActivity({ chain: { rpcUrls: { default: { http: ["https://studionet.example/api"] } } }, getBlockNumber: async () => 1787481680n }, indexedWallet, { now: "2026-08-23T00:00:00Z" });
    const payload = serializeCanonicalEvidence(scan.evidence, indexedWallet);
    assert.equal(scan.evidence.transaction_count, 160);
    assert.ok(payload.length < 20000);
    assert.equal(scan.evidence.scan_method, "address_index");
    assert.equal(scan.evidence.coverage_type, "indexed_history");
    assert.ok(!("scan_start_block" in scan.evidence));
    assert.ok(!("scan_end_block" in scan.evidence));
    assert.equal(scan.evidence.indexed_records, 160);
    assert.ok(scan.transactionHashes.length === 160);
    for (const field of ["transaction_count", "active_days", "unique_contracts", "activity_intervals_seconds", "daily_activity_counts", "median_interval_seconds", "repetition_ratio_bps", "regularity_score_bps"]) assert.ok(field in scan.evidence);
  } finally { globalThis.fetch = originalFetch; }
});

test("browser indexed scan emits safe diagnostics and never enters block scanning", async () => {
  const indexedWallet = "0xe4220c4b71877bb94eb173f467ef5c5557017085";
  const records = Array.from({ length: 160 }, (_, index) => ({
    hash: index === 0 ? "0xb88c992eadcf2bdd3b7dc878b0dc0bbbef6947b925297cc2d98a63abffb9bfdd" : `0x${String(index).padStart(64, "0")}`,
    from_address: indexedWallet.toUpperCase(),
    to_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    created_at: `2026-08-${String(1 + (index % 20)).padStart(2, "0")}T12:00:00.000Z`,
  }));
  const diagnostics = [];
  const originalFetch = globalThis.fetch;
  let blockCalls = 0;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(url, "https://studio.genlayer.com/api");
    assert.deepEqual(body, { jsonrpc: "2.0", id: 1, method: "sim_getTransactionsForAddress", params: [indexedWallet] });
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: records }) };
  };
  try {
    const scan = await scanWalletActivity({
      chain: { rpcUrls: { default: { http: ["https://studio.genlayer.com/api"] } } },
      getBlockNumber: async () => 1787481680n,
      getBlock: async () => { blockCalls += 1; throw new Error("block scan must not run"); },
    }, indexedWallet, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic), now: "2026-08-23T00:00:00Z" });
    assert.equal(blockCalls, 0);
    assert.equal(scan.evidence.scan_method, "address_index");
    assert.equal(scan.evidence.coverage_type, "indexed_history");
    assert.equal(scan.evidence.transaction_count, 160);
    assert.ok(serializeCanonicalEvidence(scan.evidence, indexedWallet).length < 20000);
    assert.equal(diagnostics[0].event, "scan_start");
    assert.equal(diagnostics[1].event, "request_start");
    assert.equal(diagnostics[1].rpcMethod, "sim_getTransactionsForAddress");
    assert.equal(diagnostics[2].event, "http_response");
    assert.equal(diagnostics[2].httpStatus, 200);
    assert.equal(diagnostics[3].event, "response_records");
    assert.equal(diagnostics[3].returnedRecords, 160);
    assert.equal(diagnostics.at(-1).event, "indexed_evidence_ready");
    assert.equal(diagnostics.at(-1).matchingRecords, 160);
  } finally { globalThis.fetch = originalFetch; }
});

test("canonical JSON and hash are independent of transaction ordering", async () => {
  const makeScan = async (records) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ result: records }) };
    };
    try {
      return await scanWalletActivity({ chain: { rpcUrls: { default: { http: ["https://studionet.example/api"] } } }, getBlockNumber: async () => 10n }, wallet, { now: "2026-08-23T00:00:00Z" });
    } finally { globalThis.fetch = originalFetch; }
  };
  const records = [
    { hash: "0x1", from_address: wallet, to_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", created_at: "2026-08-01T00:00:00Z" },
    { hash: "0x2", from_address: wallet, to_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", created_at: "2026-08-02T00:00:00Z" },
  ];
  const first = await makeScan(records);
  const second = await makeScan([...records].reverse());
  const firstJson = serializeCanonicalEvidence(first.evidence, wallet);
  const secondJson = serializeCanonicalEvidence(second.evidence, wallet);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(firstJson, secondJson);
  assert.equal(digest(firstJson), digest(secondJson));
});

test("batched RPC timeout and cancellation leave no successful scan result", async () => {
  const originalFetch = globalThis.fetch;
  const { client, fetchImpl } = batchedClient({ delayMs: 100 });
  globalThis.fetch = fetchImpl;
  try {
    await assert.rejects(() => scanWalletActivity(client, wallet, { maxBlocks: 2, adaptiveRanges: [2], batchSize: 2, rpcTimeoutMs: 10, scanTimeoutMs: 100 }), (error) => error.code === "SCAN_TIMEOUT");
    const controller = new AbortController();
    const pending = scanWalletActivity(client, wallet, { maxBlocks: 2, adaptiveRanges: [2], batchSize: 2, rpcTimeoutMs: 1000, signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, (error) => error.code === "SCAN_CANCELLED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
