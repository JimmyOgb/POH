import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../../frontend/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../../frontend/index.html", import.meta.url), "utf8");
const htmlIds = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
const appIds = [...app.matchAll(/\$\(["']([^"']+)["']\)/g)].map((match) => match[1]);

test("every app DOM selector has a matching frontend element", () => {
  const missing = [...new Set(appIds)].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `Missing frontend IDs: ${missing.join(", ")}`);
});

test("startup-required elements are present", () => {
  const required = [
    "contract-pill", "network-status", "wallet-status", "connect-wallet",
    "wallet-state-button", "wallet-help", "hero-wallet", "technical-contract", "admin", "registry",
    "scan-button", "scan-extended-button", "scan-state", "scan-result",
    "query-button", "ev-button", "ev-state", "revoke-button", "revoke-state",
    "ev-payload", "payload-count", "ev-attestation", "ev-wallet", "query-wallet",
    "revoke-wallet", "ev-terminal", "revoke-terminal", "tx-log", "ev-result",
    "query-result", "result-empty", "assessment-progress", "assessment-transaction", "contract-test-button", "contract-test-state",
  ];
  assert.deepEqual(required.filter((id) => !htmlIds.has(id)), []);
});
