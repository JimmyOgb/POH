import test from "node:test";
import assert from "node:assert/strict";
import { readDeployedContract, assertContractSchemaVersion } from "../../frontend/contract-connection.js";

const address = "0x4FAE1cdCB3c72ec3B22A5b1649D94fE3c4530247";
const wallet = "0xE4220c4b71877bb94EB173f467ef5c5557017085";

test("contract connection diagnostic uses exact deployed read methods and arguments", async () => {
  const calls = [];
  const client = { readContract: async (request) => {
    calls.push(request);
    if (request.functionName === "get_admin") return "0xadmin";
    if (request.functionName === "get_registry") return "[]";
    return JSON.stringify({ evaluated: false, wallet: request.args[0].toLowerCase() });
  } };
  const result = await readDeployedContract(client, address, wallet);
  assert.deepEqual(calls.map(({ address: calledAddress, functionName, args }) => ({ address: calledAddress, functionName, args })), [
    { address, functionName: "get_admin", args: [] },
    { address, functionName: "get_registry", args: [] },
    { address, functionName: "get_humanity_status", args: [wallet] },
  ]);
  assert.equal(result.status.evaluated, false);
});

test("contract connection diagnostic surfaces read errors", async () => {
  await assert.rejects(() => readDeployedContract({ readContract: async () => { throw new Error("RPC unavailable"); } }, address, wallet), /RPC unavailable/);
});

test("schema-v2 write guard accepts only the new contract", async () => {
  const calls = [];
  const client = { readContract: async (request) => { calls.push(request); return "2"; } };
  assert.equal(await assertContractSchemaVersion(client, address), "2");
  assert.deepEqual(calls, [{ address, functionName: "get_evidence_schema_version", args: [] }]);
  await assert.rejects(() => assertContractSchemaVersion({ readContract: async () => "1" }, address), /supports evidence schema v1/);
  await assert.rejects(() => assertContractSchemaVersion({ readContract: async () => { throw new Error("Method not found"); } }, address), /does not expose evidence schema v2/);
});
