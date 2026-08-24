function parseStringResult(raw) {
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function readDeployedContract(client, address, walletAddress) {
  if (!client || typeof client.readContract !== "function") throw new Error("GenLayer read client is unavailable.");
  const read = (functionName, args) => client.readContract({ address, functionName, args });
  const admin = await read("get_admin", []);
  const registry = parseStringResult(await read("get_registry", []));
  const status = parseStringResult(await read("get_humanity_status", [walletAddress]));
  return { admin, registry, status };
}

export async function assertContractSchemaVersion(client, address, expectedVersion = "2") {
  if (!client || typeof client.readContract !== "function") throw new Error("GenLayer read client is unavailable.");
  let actual;
  try {
    actual = await client.readContract({ address, functionName: "get_evidence_schema_version", args: [] });
  } catch (error) {
    throw new Error(`The connected contract does not expose evidence schema v${expectedVersion}; redeploy the schema-v2 contract before submitting. ${error?.message || "Schema version read failed."}`);
  }
  actual = typeof actual === "string" ? actual : String(actual);
  if (actual !== expectedVersion) throw new Error(`The connected contract supports evidence schema v${actual}, but this frontend requires v${expectedVersion}. Redeploy before submitting.`);
  return actual;
}
