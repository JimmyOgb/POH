import test from "node:test";
import assert from "node:assert/strict";
import config from "../../frontend/config.js";
import { CONTRACT_ADDRESS, CONTRACT_SCHEMA, assertEvaluateWalletArgs, buildEvaluateWalletArgs } from "../../frontend/contract.js";
import { CalldataAddress } from "genlayer-js/types";
import { connectStudionet, isStudionetChain, walletError, STUDIONET_CHAIN_ID_HEX } from "../../frontend/wallet.js";

const chain = { id: 61999, name: "Genlayer Studio Network" };

test("configuration points to the deployed Studionet contract", () => {
  assert.equal(config.network, "studionet");
  assert.equal(config.chainId, 61999);
  assert.equal(config.contractAddress, "0x882E6E8A2Dd5061673716dB46f13EDf576a0E8aF");
  assert.equal(config.contractSchemaVersion, "2");
  assert.equal(config.scanMaxBlocks, 50);
  assert.equal(config.scanExtendedMaxBlocks, 500);
  assert.equal(config.scanTimeoutMs, 30000);
  assert.equal(config.scanExtendedTimeoutMs, 60000);
  assert.deepEqual(config.scanAdaptiveRanges, [50]);
  assert.equal(config.scanRpcTimeoutMs, 10000);
  assert.equal(config.scanConcurrency, 5);
  assert.equal(CONTRACT_ADDRESS, config.contractAddress);
});

test("deployed contract API and evaluate_wallet argument order are explicit", () => {
  assert.deepEqual(CONTRACT_SCHEMA.evaluate_wallet, { args: ["string", "string"], readonly: false, returns: "string" });
  assert.deepEqual(Object.fromEntries(Object.entries(CONTRACT_SCHEMA).map(([name, method]) => [name, { args: method.args, readonly: method.readonly, returns: method.returns }])), {
    evaluate_wallet: { args: ["string", "string"], readonly: false, returns: "string" },
    revoke_status: { args: ["string"], readonly: false, returns: "string" },
    get_admin: { args: [], readonly: true, returns: "string" },
    get_evidence_schema_version: { args: [], readonly: true, returns: "string" },
    get_registry: { args: [], readonly: true, returns: "string" },
    get_humanity_status: { args: ["string"], readonly: true, returns: "string" },
    get_score: { args: ["string"], readonly: true, returns: "string" },
    get_status: { args: ["string"], readonly: true, returns: "string" },
    set_evaluator_authorization: { args: ["string", "bool"], readonly: false, returns: "string" },
    is_evaluator_authorized: { args: ["string", "string"], readonly: true, returns: "bool" },
  });
  const args = buildEvaluateWalletArgs(new String("0x1111111111111111111111111111111111111111"), new String("{\"wallet\":\"evidence\"}"));
  assert.deepEqual(args, ["0x1111111111111111111111111111111111111111", "{\"wallet\":\"evidence\"}"]);
  assert.deepEqual(args.map((value) => typeof value), ["string", "string"]);
  assert.strictEqual(assertEvaluateWalletArgs(args), args);
  assert.throws(() => buildEvaluateWalletArgs("not-a-wallet", "{}"), /valid wallet/);
  assert.throws(() => buildEvaluateWalletArgs("0xE4220c4b71877bb94EB173f467ef5c5557017085", ""), /Canonical evidence is required/);
});

test("evaluate_wallet write boundary rejects GenLayerJS address-typed calldata", () => {
  const addressBytes = Uint8Array.from({ length: 20 }, (_, index) => index + 1);
  const typedAddress = new CalldataAddress(addressBytes);
  assert.throws(
    () => assertEvaluateWalletArgs([typedAddress, "{}"]),
    /walletAddress must be a JavaScript string/,
  );
  const args = buildEvaluateWalletArgs("0x2222222222222222222222222222222222222222", "{}");
  assert.equal(typeof args[0], "string");
  assert.equal(typeof args[1], "string");
});

test("wallet helper detects the Studionet chain", () => {
  assert.equal(isStudionetChain(STUDIONET_CHAIN_ID_HEX), true);
  assert.equal(isStudionetChain("0x1"), false);
});

test("missing wallet is actionable", async () => {
  await assert.rejects(() => connectStudionet({ provider: undefined, createClient: () => null, chain }), /No browser wallet detected/);
});

test("already-connected Studionet wallet does not request a network switch", async () => {
  const calls = [];
  const provider = { request: async ({ method }) => { calls.push(method); if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"]; return STUDIONET_CHAIN_ID_HEX; } };
  const clients = [];
  const result = await connectStudionet({ provider, createClient: (options) => { const client = { options, connect: async () => { throw new Error("must not switch"); } }; clients.push(client); return client; }, chain });
  assert.equal(result.account, "0x1111111111111111111111111111111111111111");
  assert.deepEqual(calls, ["eth_requestAccounts", "eth_chainId"]);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].options.chain, chain);
  assert.equal(clients[0].options.account, "0x1111111111111111111111111111111111111111");
  assert.equal(clients[0].options.provider, provider);
});

test("wrong network uses the SDK connect flow and rechecks the chain", async () => {
  const calls = [];
  let chainId = "0x1";
  const provider = { request: async ({ method }) => { calls.push(method); if (method === "eth_requestAccounts") return ["0x2222222222222222222222222222222222222222"]; if (method === "eth_chainId") return chainId; throw new Error(`unexpected ${method}`); } };
  const client = { connect: async (network) => { assert.equal(network, "studionet"); chainId = STUDIONET_CHAIN_ID_HEX; } };
  const result = await connectStudionet({ provider, createClient: () => client, chain });
  assert.equal(result.ready, undefined);
  assert.deepEqual(calls, ["eth_requestAccounts", "eth_chainId", "eth_chainId"]);
});

test("wrong network can be detected without prompting a switch", async () => {
  const provider = { request: async ({ method }) => method === "eth_accounts" ? ["0x3333333333333333333333333333333333333333"] : "0x1" };
  const result = await connectStudionet({ provider, createClient: () => ({ connect: async () => { throw new Error("must not switch"); } }), chain, requestAccounts: false, autoSwitch: false });
  assert.equal(result.ready, false);
  assert.equal(result.chainId, "0x1");
});

test("wallet rejection is converted to an actionable message", () => {
  assert.equal(walletError({ code: 4001 }), "Wallet request was rejected. Please approve the request to continue.");
});

test("rejected Studionet switch is surfaced to the caller", async () => {
  const provider = { request: async ({ method }) => method === "eth_requestAccounts" ? ["0x4444444444444444444444444444444444444444"] : "0x1" };
  const client = { connect: async () => { throw Object.assign(new Error("User rejected"), { code: 4001 }); } };
  await assert.rejects(() => connectStudionet({ provider, createClient: () => client, chain }), { code: 4001 });
});
