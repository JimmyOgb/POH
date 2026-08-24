import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { assertSuccessfulFinalization, pollForFinalizedTransaction } from "./transaction.js";
import config from "./config.js";
import { connectStudionet, isStudionetChain, walletError, STUDIONET_CHAIN_ID } from "./wallet.js";
import { scanWalletActivity, serializeCanonicalEvidence, validateCanonicalEvidencePayload } from "./scanner.js";
import { assertEvaluateWalletArgs, buildEvaluateWalletArgs } from "./contract.js";
import { EVIDENCE_STATES, evidenceUiState, canSubmitEvidence } from "./evidence-state.js";
import { readDeployedContract, assertContractSchemaVersion } from "./contract-connection.js";
import { friendlyInterpretation, plainExplanation, RESULT_DISCLAIMER } from "./result-presentation.js";
import { scanOutcome } from "./scan-flow.js";

const WALLET = /^0x[0-9a-fA-F]{40}$/;
const EXPECTED_NETWORK = "studionet";
const EXPECTED_CHAIN_ID = STUDIONET_CHAIN_ID;
const queryContract = new URLSearchParams(location.search).get("contract");
const CONTRACT_ADDRESS = queryContract || config.contractAddress;
const state = { walletAddress: "", walletClient: null, walletReady: false, evidenceReady: false, evidenceWallet: "", canonicalEvidence: "", evidenceState: EVIDENCE_STATES.DISCONNECTED, scanRun: 0, scanAbortController: null, transactions: [] };
const pageLifecycle = new AbortController();
window.addEventListener("pagehide", () => pageLifecycle.abort(), { once: true });

const $ = (id) => document.getElementById(id);
const short = (value) => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "—";
const validWallet = (value) => WALLET.test(value);
const parseRecord = (raw) => typeof raw === "string" ? JSON.parse(raw) : raw;
const text = (parent, value, className = "") => { const node = document.createTextNode(String(value ?? "—")); if (className) node.className = className; parent.append(node); return node; };
const clear = (id) => $(id).replaceChildren();
const configurationError = (() => {
  if (config.network !== EXPECTED_NETWORK) return `Unsupported network "${config.network}".`;
  if (Number(config.chainId) !== EXPECTED_CHAIN_ID) return `Invalid Studionet chain ID ${config.chainId}; expected ${EXPECTED_CHAIN_ID}.`;
  if (!validWallet(CONTRACT_ADDRESS || "")) return "The configured contract address is invalid.";
  return "";
})();
const readClient = configurationError ? null : createClient({ chain: studionet });
const isDevelopment = typeof location !== "undefined" && ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
const contractDebug = (message, data) => { if (isDevelopment) console.debug(`[contract] ${message}`, data ?? ""); };
contractDebug(`address = ${CONTRACT_ADDRESS}`);
contractDebug(`network = ${config.network}`);
contractDebug(`chainId = ${config.chainId}`);

function safeOrigin(endpoint) {
  try { return new URL(endpoint).origin; } catch { return "unavailable"; }
}

function renderRuntimeDiagnostics() {
  const endpoint = readClient?.chain?.rpcUrls?.default?.http?.[0] || "";
  const values = {
    "runtime-environment": "static frontend configuration",
    "runtime-network": `${config.network} · ${readClient?.chain?.name || "unknown"}`,
    "runtime-chain-id": String(readClient?.chain?.id ?? config.chainId),
    "runtime-rpc-origin": safeOrigin(endpoint),
    "runtime-provider": "GenLayerJS public RPC for reads/scanner; window.ethereum for wallet/write provider",
    "runtime-contract": CONTRACT_ADDRESS,
    "runtime-scan-blocks": String(config.scanMaxBlocks),
    "runtime-scan-timeout": `${config.scanTimeoutMs} ms overall / ${config.scanRpcTimeoutMs} ms RPC`,
  };
  Object.entries(values).forEach(([id, value]) => { if ($(id)) $(id).textContent = value; });
  if (isDevelopment) console.debug("[runtime] ENV CONFIG", values);
}

function friendlyError(error, fallback = "The operation could not be completed.") {
  if (error?.code === "POLLING_TIMEOUT") return "GenLayer RPC polling timed out. The transaction hash is preserved; inspect it in Studio before retrying.";
  if (error?.transaction?.txExecutionResultName === "FINISHED_WITH_ERROR") {
    return "Transaction finalized but execution failed.";
  }
  return walletError(error, fallback);
}

function setNetwork(label, className = "") {
  const el = $("network-status"); el.className = "pill"; if (className) el.classList.add(className); el.textContent = label;
}

function setWallet(label, className = "") {
  const el = $("wallet-status"); el.className = "pill"; if (className) el.classList.add(className); el.textContent = label;
}

function setWriteAvailability(ready) {
  state.walletReady = ready;
  $("ev-button").disabled = !(ready && state.evidenceReady);
  $("revoke-button").disabled = !ready;
  $("contract-test-button").disabled = !ready;
  if (!ready && $("ev-state").textContent === "Ready") $("ev-state").textContent = "Connect wallet first";
}

function syncEvidenceState(nextState) {
  state.evidenceState = nextState;
  const ui = evidenceUiState(state, nextState);
  $("scan-state").textContent = ui.message;
  $("scan-button").disabled = !ui.scanEnabled;
  $("ev-button").disabled = !ui.assessmentEnabled;
}

const PROGRESS_STATES = ["SUBMITTED", "PENDING", "PROPOSING", "COMMITTING", "REVEALING", "FINALIZED"];
function updateAssessmentProgress(status = "") {
  const current = String(status).toUpperCase();
  const currentIndex = PROGRESS_STATES.indexOf(current);
  document.querySelectorAll("#assessment-progress .progress-step").forEach((step) => {
    const index = PROGRESS_STATES.indexOf(step.dataset.status);
    step.classList.toggle("is-complete", currentIndex >= 0 && index < currentIndex);
    step.classList.toggle("is-active", currentIndex >= 0 && index === currentIndex);
  });
}

function setWalletAddress(address) {
  state.walletAddress = address || "";
  ["ev-wallet", "query-wallet", "revoke-wallet"].forEach((id) => { if (address) $(id).value = address; });
}

function clearEvidence(nextState = state.walletReady ? EVIDENCE_STATES.READY_TO_SCAN : EVIDENCE_STATES.DISCONNECTED) {
  state.scanAbortController?.abort();
  state.scanAbortController = null;
  state.scanRun += 1;
  state.evidenceReady = false;
  state.evidenceWallet = "";
  state.canonicalEvidence = "";
  $("ev-payload").value = "";
  $("scan-result").replaceChildren();
  $("scan-result").hidden = true;
  $("scan-extended-button").hidden = true;
  $("ev-button").textContent = "Run assessment";
  syncEvidenceState(nextState);
  setWriteAvailability(state.walletReady);
}

function renderScan(evidence, mode) {
  const result = $("scan-result"); result.replaceChildren(); result.hidden = false;
  const heading = document.createElement("div"); heading.className = "scan-result-heading"; text(heading, evidence.scan_method === "address_index" ? "Indexed wallet history" : mode === "extended" ? "Extended scan" : "Quick scan"); result.append(heading);
  const coverageMetric = evidence.scan_method === "address_index"
    ? [evidence.indexed_records, "Indexed records"]
    : [evidence.blocks_scanned, "Blocks scanned"];
  [coverageMetric, [evidence.transaction_count, "Transactions found"], [evidence.active_days, "Active days"], [evidence.unique_contracts, "Unique contracts"], [evidence.activity_intervals_seconds.length, "Activity intervals"], [evidence.median_interval_seconds, "Median activity interval (s)"], [`${evidence.repetition_ratio_bps} bps`, "Repetition ratio"], [`${evidence.regularity_score_bps} bps`, "Regularity"]].forEach(([value, label]) => {
    const metric = document.createElement("div"); metric.className = "scan-metric"; text(metric, value, ""); const caption = document.createElement("span"); text(caption, label); metric.append(caption); result.append(metric);
  });
  const source = document.createElement("div"); source.className = "scan-source"; text(source, evidence.scan_method === "address_index" ? `Source: ${evidence.source} · indexed transaction records · no block range downloaded` : evidence.transaction_count === 0 ? `0 transactions found in this scan · ${evidence.blocks_scanned} blocks checked · this does not establish wallet inactivity` : `Source: ${evidence.source} · blocks ${evidence.scan_start_block}–${evidence.scan_end_block}`); result.append(source);
}

async function scan(mode = "quick") {
  if (!state.walletReady || !state.walletAddress) return handleWalletError(new Error("Connect your wallet on GenLayer Studionet first."));
  state.scanAbortController?.abort();
  clearEvidence(EVIDENCE_STATES.READY_TO_SCAN);
  const scanController = new AbortController();
  const walletAtScanStart = state.walletAddress.toLowerCase();
  const scanRun = ++state.scanRun;
  state.scanAbortController = scanController;
  syncEvidenceState(EVIDENCE_STATES.SCANNING); $("scan-result").hidden = true; $("scan-extended-button").hidden = true;
  const extended = mode === "extended";
  try {
    const scanResult = await scanWalletActivity(readClient, walletAtScanStart, {
      maxBlocks: extended ? config.scanExtendedMaxBlocks : config.scanMaxBlocks,
      scanTimeoutMs: extended ? config.scanExtendedTimeoutMs : config.scanTimeoutMs,
      rpcTimeoutMs: config.scanRpcTimeoutMs,
      concurrency: config.scanConcurrency,
      batchSize: config.scanBatchSize,
      batchConcurrency: config.scanBatchConcurrency,
      adaptiveRanges: config.scanAdaptiveRanges,
      signal: scanController.signal,
      onProgress: ({ phase, completed, total, scanStartBlock, scanEndBlock }) => {
        if (scanRun !== state.scanRun || state.evidenceState !== EVIDENCE_STATES.SCANNING) return;
        if (phase === "latest") $("scan-state").textContent = "Reading latest Studionet block…";
        else if (phase === "indexed") $("scan-state").textContent = "Searching indexed Studionet wallet activity…";
        else if (phase === "evidence") $("scan-state").textContent = "Analyzing activity…";
        else if (scanStartBlock !== undefined && scanEndBlock !== undefined) $("scan-state").textContent = `${extended ? "Scanning extended history" : "Scanning wallet"}… ${completed} / ${total} blocks`;
        else $("scan-state").textContent = `Scanning wallet… ${completed} / ${total} blocks`;
      },
      onDiagnostic: (diagnostic) => {
        if (config.scanDiagnostics) console.debug("[wallet-scan-diagnostic]", diagnostic);
      },
    });
    if (scanRun !== state.scanRun || !state.walletReady || state.walletAddress.toLowerCase() !== walletAtScanStart) throw new Error("Wallet changed while scanning. Please scan the connected wallet again.");
    const evidence = scanResult.evidence;
    const payload = serializeCanonicalEvidence(evidence, walletAtScanStart);
    validateCanonicalEvidencePayload(payload, walletAtScanStart);
    if (payload.length > 20000) throw new Error("The scanned evidence is too large for the contract payload limit.");
    const outcome = scanOutcome({ mode, transactionCount: evidence.transaction_count, completed: true, canSearchDeeper: false });
    state.canonicalEvidence = payload;
    $("ev-payload").value = payload;
    state.evidenceReady = outcome.assessmentAllowed; state.evidenceWallet = walletAtScanStart;
    renderScan(evidence, mode); syncEvidenceState(EVIDENCE_STATES.SCAN_SUCCESS); setWriteAvailability(true);
    if (outcome.recommendExtended) { $("scan-state").textContent = "No activity found in this scan. This does not mean the wallet is inactive."; $("scan-extended-button").hidden = false; }
    else if (outcome.limitedEvidence) { $("scan-state").textContent = evidence.scan_method === "address_index" ? "No activity found in indexed history. This does not mean the wallet is inactive." : "No wallet activity was observed in the scanned range."; $("ev-button").textContent = "Assess limited evidence"; }
    else $("scan-state").textContent = evidence.transaction_count === 0 ? (evidence.scan_method === "address_index" ? "No activity found in indexed history. This does not mean the wallet is inactive." : "No wallet activity was observed in the scanned range.") : "Wallet activity detected";
    $("ev-state").textContent = state.evidenceReady ? "Scan complete · Ready to assess" : "Scan complete · Scan wider to continue";
  } catch (error) {
    if (scanRun === state.scanRun && error?.code !== "SCAN_CANCELLED") {
      clearEvidence(state.walletReady ? EVIDENCE_STATES.READY_TO_SCAN : EVIDENCE_STATES.DISCONNECTED);
      $("scan-state").textContent = error?.code === "SCAN_TIMEOUT" ? `Wallet scan timed out (${error.timeoutSource || "unknown timeout source"}). Unable to complete the requested Studionet scan. No assessment was submitted.` : `Wallet scan failed: ${error?.message || "RPC data unavailable."}`;
      terminal("ev-terminal", $("scan-state").textContent, "error");
    }
  } finally {
    if (state.scanAbortController === scanController) state.scanAbortController = null;
    if (scanRun === state.scanRun && state.evidenceState === EVIDENCE_STATES.SCANNING) clearEvidence(state.walletReady ? EVIDENCE_STATES.READY_TO_SCAN : EVIDENCE_STATES.DISCONNECTED);
  }
}

function showConfigurationError() {
  setNetwork(`Configuration error: ${configurationError}`, "error");
  $("admin").textContent = "Configuration required";
  const message = document.createElement("div"); message.className = "empty error"; text(message, `${configurationError} Update frontend/config.js.`); $("registry").replaceChildren(message);
  $("connect-wallet").disabled = true; $("wallet-state-button").disabled = true; $("scan-button").disabled = true; $("query-button").disabled = true; setWriteAvailability(false);
}

function addLog(method, status, detail, hash = "") {
  state.transactions.unshift({ method, status, detail, hash, at: new Date().toLocaleTimeString() });
  const table = document.createElement("table"), head = table.createTHead().insertRow(), body = table.createTBody();
  ["Method", "Status", "Detail", "Transaction", "Time"].forEach((label) => text(head.insertCell(), label));
  state.transactions.slice(0, 12).forEach((tx) => {
    const row = body.insertRow(), color = tx.status === "Successful" ? "human" : tx.status === "Failed" ? "sybil" : "unknown";
    [tx.method, tx.status, tx.detail, tx.hash ? short(tx.hash) : "—", tx.at].forEach((value, index) => text(row.insertCell(), value, index === 1 ? color : ""));
  });
  $("tx-log").replaceChildren(table);
}

function terminal(id, line, className = "") {
  const el = $(id); el.classList.add("show"); const entry = document.createElement("span"); text(entry, line, className); el.append(entry, document.createTextNode("\n")); el.scrollTop = el.scrollHeight;
}

function showRecord(record, target = "query-result", transactionHash = "") {
  const el = $(target); const mainResult = target === "ev-result"; el.replaceChildren();
  if (!record?.evaluated) {
    el.classList.remove("show");
    if (mainResult && $("result-empty")) $("result-empty").hidden = false;
    if (!mainResult) { const empty = document.createElement("div"); empty.className = "empty"; text(empty, "No behavioral assessment found for this wallet."); el.append(empty); el.classList.add("show"); }
    return;
  }
  el.classList.add("show");
  if (mainResult && $("result-empty")) $("result-empty").hidden = true;
  const interpretation = friendlyInterpretation(record);
  const evidence = evidenceForRecord(record);
  const resultSection = document.createElement("section"); resultSection.className = "plain-result-section";
  const resultHeading = document.createElement("p"); resultHeading.className = "eyebrow"; text(resultHeading, "Behavioral Reputation"); resultSection.append(resultHeading);
  const title = document.createElement("h3"); title.className = "friendly-result-title"; text(title, interpretation.label, interpretation.tone); resultSection.append(title);
  const score = document.createElement("div"); score.className = "friendly-score"; text(score, `${record.score ?? "—"} / 100`); resultSection.append(score);
  const risk = document.createElement("div"); risk.className = "friendly-risk"; text(risk, `${record.risk || "Unknown"} behavioral risk`); resultSection.append(risk);
  const why = document.createElement("section"); why.className = "plain-result-section"; const whyHeading = document.createElement("p"); whyHeading.className = "eyebrow"; text(whyHeading, "Why"); why.append(whyHeading);
  const explanation = document.createElement("p"); explanation.className = "plain-result-copy"; text(explanation, plainExplanation(record, evidence)); why.append(explanation);
  if (evidence) { const observedHeading = document.createElement("h4"); text(observedHeading, "What we observed:"); why.append(observedHeading); const observed = document.createElement("ul"); observed.className = "observed-list"; const coverage = evidence.scan_method === "address_index" ? [[evidence.indexed_records ?? evidence.transaction_count, "indexed records"]] : [[evidence.blocks_scanned, "blocks scanned"]]; [...coverage, [evidence.transaction_count, "transactions"], [evidence.active_days, "active days"], [evidence.unique_contracts, "unique applications"], [evidence.activity_intervals_seconds?.length ?? 0, "activity intervals"]].forEach(([value, label]) => { const item = document.createElement("li"); text(item, `${value} ${label}`); observed.append(item); }); why.append(observed); }
  const disclaimer = document.createElement("section"); disclaimer.className = "plain-result-section disclaimer"; const disclaimerHeading = document.createElement("p"); disclaimerHeading.className = "eyebrow"; text(disclaimerHeading, "What this does not mean"); disclaimer.append(disclaimerHeading); const disclaimerText = document.createElement("p"); disclaimerText.className = "plain-result-copy"; text(disclaimerText, RESULT_DISCLAIMER); disclaimer.append(disclaimerText);
  const guide = document.createElement("details"); guide.className = "interpretation-guide"; const guideSummary = document.createElement("summary"); text(guideSummary, "How to interpret this"); guide.append(guideSummary); const guideList = document.createElement("ul"); [["80–100", "Strong behavioral evidence", "The observed activity contains multiple behavioral signals that validators considered strong."], ["40–79", "Moderate behavioral evidence", "Some behavioral signals were observed, but the evidence is mixed or incomplete."], ["0–39", "Insufficient behavioral evidence", "There was not enough observable behavioral activity to support a strong assessment."]].forEach(([range, label, description]) => { const item = document.createElement("li"); const strong = document.createElement("strong"); text(strong, `${range} — ${label}`); const copy = document.createElement("span"); text(copy, description); item.append(strong, copy); guideList.append(item); }); guide.append(guideList);
  el.append(resultSection, why, disclaimer, guide);
  const technical = document.createElement("details"); technical.className = "technical-result"; const summary = document.createElement("summary"); text(summary, "Technical result"); technical.append(summary); const list = document.createElement("dl"); list.className = "technical-list"; [["wallet", short(record.wallet)], ["raw status", record.status || "—"], ["score band", record.score_band || "—"], ["risk", record.risk || "—"], ["evaluator", short(record.evaluated_by)], ["evidence hash", record.evidence_hash || "—"], ["schema version", record.evidence_schema_version || "—"], ["transaction hash", transactionHash ? short(transactionHash) : "—"], ["raw reasoning", record.reasoning || "—"]].forEach(([key, value]) => { const dt = document.createElement("dt"); text(dt, key); const dd = document.createElement("dd"); text(dd, value); list.append(dt, dd); }); technical.append(list); el.append(technical);
  if (mainResult) $("hero-wallet").textContent = record.wallet;
}

function evidenceForRecord(record) {
  if (!state.canonicalEvidence || !record?.wallet) return null;
  try { const evidence = JSON.parse(state.canonicalEvidence); return String(evidence.wallet).toLowerCase() === String(record.wallet).toLowerCase() ? evidence : null; } catch { return null; }
}

function renderRegistry(records) {
  $("registry").replaceChildren();
  if (!records.length) { const empty = document.createElement("div"); empty.className = "empty"; text(empty, "No wallets evaluated yet."); $("registry").append(empty); return; }
  const table = document.createElement("table"), head = table.createTHead().insertRow(), body = table.createTBody();
  ["Wallet", "Score", "Interpretation", "Risk", "Raw status", "Reasoning"].forEach((label) => text(head.insertCell(), label));
  records.forEach((record) => { const row = body.insertRow(), interpretation = friendlyInterpretation(record); [short(record.wallet), record.score ?? "—", interpretation.label, record.risk || "—"].forEach((value, index) => text(row.insertCell(), value, index === 2 ? interpretation.tone : "")); const raw = row.insertCell(); text(raw, record.status || "—", "mono"); const reasoning = row.insertCell(); const preview = document.createElement("span"); text(preview, `${record.reasoning || "No reasoning recorded."}`.slice(0, 100) + ((record.reasoning || "").length > 100 ? "…" : "")); reasoning.append(preview); if ((record.reasoning || "").length > 100) { const details = document.createElement("details"); const summary = document.createElement("summary"); text(summary, "View reasoning"); const full = document.createElement("p"); full.className = "table-reasoning"; text(full, record.reasoning); details.append(summary, full); reasoning.append(details); } });
  $("registry").append(table);
}

async function readRegistry() {
  const raw = await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_registry", args: [] });
  contractDebug("get_registry = success");
  renderRegistry(parseRecord(raw));
}

async function readStatus(wallet, target = "query-result", transactionHash = "") {
  const raw = await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_humanity_status", args: [wallet] });
  contractDebug("get_humanity_status = success");
  const record = parseRecord(raw); showRecord(record, target, transactionHash); return record;
}

async function testContractConnection() {
  if (!state.walletReady || !state.walletAddress) return handleWalletError(new Error("Connect your wallet on GenLayer Studionet first."));
  const button = $("contract-test-button"); button.disabled = true; $("contract-test-state").textContent = "Reading deployed contract…";
  try {
    await readDeployedContract(readClient, CONTRACT_ADDRESS, state.walletAddress);
    const schemaVersion = await assertContractSchemaVersion(readClient, CONTRACT_ADDRESS, config.contractSchemaVersion);
    contractDebug("get_admin = success"); contractDebug("get_registry = success"); contractDebug("get_humanity_status = success"); contractDebug("get_evidence_schema_version = success", { schemaVersion });
    $("contract-test-state").textContent = "Contract reads succeeded";
  } catch (error) {
    contractDebug("read failed", { name: error?.name, code: error?.code, message: error?.message });
    $("contract-test-state").textContent = `Contract read failed: ${friendlyError(error)}`;
  } finally { button.disabled = !state.walletReady; }
}

function syncWalletUi(result) {
  if (!result) {
    state.walletClient = null; setWalletAddress(""); setWriteAvailability(false); clearEvidence(EVIDENCE_STATES.DISCONNECTED); setWallet("Wallet: not connected"); setNetwork("GenLayer Studionet"); $("connect-wallet").textContent = "Connect Wallet"; $("wallet-state-button").textContent = "Connect Wallet"; $("hero-wallet").textContent = "Connect your wallet to begin an assessment."; $("wallet-help").textContent = "Connect wallet to begin"; return;
  }
  const previousWallet = state.walletAddress;
  setWalletAddress(result.account);
  if (result.ready === false) {
    state.walletClient = null; setWriteAvailability(false); clearEvidence(EVIDENCE_STATES.CONNECTED_WRONG_NETWORK); setWallet(`Wallet: ${short(result.account)} · wrong network`, "error"); setNetwork("Switch to GenLayer Studionet", "warn"); $("connect-wallet").textContent = "Switch Network"; $("wallet-state-button").textContent = "Switch to Studionet"; $("hero-wallet").textContent = "Wrong network"; $("wallet-help").textContent = "Switch to GenLayer Studionet to continue."; return;
  }
  const changed = previousWallet && previousWallet.toLowerCase() !== result.account.toLowerCase();
  state.walletClient = result.client; setWriteAvailability(true); if (changed || !state.evidenceReady) clearEvidence(EVIDENCE_STATES.READY_TO_SCAN); else syncEvidenceState(EVIDENCE_STATES.SCAN_SUCCESS); setWallet(`Connected ${short(result.account)}`, "human"); setNetwork("GenLayer Studionet · 61999", "human"); $("connect-wallet").textContent = "Wallet Connected"; $("wallet-state-button").textContent = "Wallet Connected"; $("hero-wallet").textContent = "Wallet connected"; $("wallet-help").textContent = `${short(result.account)} · GenLayer Studionet`;
  $("ev-state").textContent = state.evidenceReady ? "Ready to assess" : "Ready to scan";
}

async function connectWallet({ requestAccounts = true, autoSwitch = true } = {}) {
  if (configurationError) throw new Error(configurationError);
  const result = await connectStudionet({ provider: window.ethereum, createClient, chain: studionet, requestAccounts, autoSwitch });
  if (!result) { syncWalletUi(null); throw new Error("No wallet account selected."); }
  syncWalletUi(result);
  const reads = await readDeployedContract(readClient, CONTRACT_ADDRESS, result.account);
  const schemaVersion = await assertContractSchemaVersion(readClient, CONTRACT_ADDRESS, config.contractSchemaVersion);
  contractDebug("get_admin = success"); contractDebug("get_registry = success"); contractDebug("get_humanity_status = success"); contractDebug("get_evidence_schema_version = success", { schemaVersion });
  $("admin").textContent = reads.admin; renderRegistry(reads.registry); showRecord(reads.status, "ev-result");
}

async function restoreAuthorizedWallet() {
  if (!window.ethereum || configurationError) return;
  try { await connectWallet({ requestAccounts: false, autoSwitch: false }); }
  catch (error) { console.debug("No authorized wallet restored:", friendlyError(error)); syncWalletUi(null); }
}

async function handleWalletError(error) {
  const message = friendlyError(error, "Wallet connection failed.");
  setWriteAvailability(false); setNetwork(message, "error"); setWallet("Wallet: not connected", "error"); $("connect-wallet").textContent = "Connect Wallet"; $("wallet-state-button").textContent = "Connect Wallet"; terminal("ev-terminal", message, "error");
}

async function handleAccountsChanged(accounts) {
  if (!accounts?.length) { syncWalletUi(null); return; }
  try { await connectWallet({ requestAccounts: false, autoSwitch: false }); }
  catch (error) { await handleWalletError(error); }
}

async function handleChainChanged() {
  if (!window.ethereum) return;
  const chainId = await window.ethereum.request({ method: "eth_chainId" }).catch(() => "");
  if (!isStudionetChain(chainId)) { syncWalletUi(state.walletAddress ? { account: state.walletAddress, ready: false } : null); return; }
  if (state.walletAddress) { try { await connectWallet({ requestAccounts: false, autoSwitch: false }); } catch (error) { await handleWalletError(error); } }
  else setNetwork("GenLayer Studionet · 61999", "human");
}

async function submitWrite(method, args, terminalId, stateId) {
  if (!state.walletReady || !state.walletClient) throw new Error("Connect your wallet on GenLayer Studionet first.");
  const hash = await state.walletClient.writeContract({ address: CONTRACT_ADDRESS, functionName: method, args, value: 0n });
  addLog(method, "Submitted", "Wallet approved; awaiting GenLayer consensus", hash); $(stateId).textContent = "Transaction submitted"; terminal(terminalId, `submitted ${hash}`); if (method === "evaluate_wallet") { $("assessment-transaction").textContent = short(hash); updateAssessmentProgress("SUBMITTED"); }
  let finalized;
  try {
    finalized = await pollForFinalizedTransaction(state.walletClient, hash, { signal: pageLifecycle.signal, onUpdate: ({ status, retrying }) => { const label = retrying ? "GenLayer RPC temporarily unavailable — retrying…" : status === "FINALIZED" ? "Finalized" : status; $(stateId).textContent = label; terminal(terminalId, retrying ? `status: ${status} · RPC retrying` : `status: ${status}`, retrying ? "error" : ""); if (method === "evaluate_wallet" && !retrying) updateAssessmentProgress(status); } });
    assertSuccessfulFinalization(finalized);
  } catch (error) { error.transactionSubmitted = true; if (finalized) error.transaction = finalized; throw error; }
  addLog(method, "Successful", "Finalized with FINISHED_WITH_RETURN", hash); terminal(terminalId, "finalized with successful execution", "ok"); if (method === "evaluate_wallet") updateAssessmentProgress("FINALIZED"); return { hash, transaction: finalized };
}

async function evaluate() {
  const wallet = $("ev-wallet").value.trim() || state.walletAddress, payload = state.canonicalEvidence, passed = $("ev-attestation").checked;
  if (!state.walletReady) return handleWalletError(new Error("Connect your wallet to GenLayer Studionet first."));
  if (!validWallet(wallet)) return alert("Connect a valid wallet before scanning.");
  if (!canSubmitEvidence({ walletReady: state.walletReady, evidenceReady: state.evidenceReady, evidenceWallet: state.evidenceWallet, wallet, payload })) return alert("Scan this wallet before running an assessment.");
  $("ev-button").disabled = true; $("ev-state").textContent = "Wallet confirmation required"; $("ev-terminal").replaceChildren();
  try {
    if (!payload || payload.trim() === "") throw new Error("Cannot submit assessment: wallet scan did not produce canonical evidence.");
    validateCanonicalEvidencePayload(payload, wallet);
    await assertContractSchemaVersion(readClient, CONTRACT_ADDRESS, config.contractSchemaVersion);
    if (["localhost", "127.0.0.1", "::1"].includes(location.hostname)) console.debug("Assessment payload ready", { walletAddress: wallet, evidenceLength: payload.length, evidenceSchemaVersion: JSON.parse(payload).schema_version, attestationPassedDemo: passed });
    state.evidenceState = EVIDENCE_STATES.ASSESSING;
    const evaluateArgs = assertEvaluateWalletArgs(buildEvaluateWalletArgs(wallet, payload, passed));
    const result = await submitWrite("evaluate_wallet", evaluateArgs, "ev-terminal", "ev-state");
    await readStatus(wallet, "ev-result", result.hash); state.evidenceState = EVIDENCE_STATES.RESULT; await readRegistry();
  }
  catch (error) { const submitted = error.transactionSubmitted === true; const statusUnknown = error.code === "POLLING_TIMEOUT"; const executionFailed = error.transaction?.txExecutionResultName === "FINISHED_WITH_ERROR"; const outcome = statusUnknown ? "RPC status unavailable" : executionFailed ? "Execution failed" : submitted ? "Failed" : "Not submitted"; terminal("ev-terminal", `${statusUnknown ? "transaction status unknown" : executionFailed ? "transaction finalized but execution failed" : submitted ? "transaction failed" : "write not submitted"}: ${friendlyError(error)}`, "error"); $("ev-state").textContent = outcome; addLog("evaluate_wallet", outcome, friendlyError(error)); }
  finally { if (state.evidenceState === EVIDENCE_STATES.ASSESSING) syncEvidenceState(EVIDENCE_STATES.SCAN_SUCCESS); setWriteAvailability(state.walletReady); }
}

async function query() {
  const wallet = $("query-wallet").value.trim() || state.walletAddress; if (!validWallet(wallet)) return alert("Connect a wallet or enter a valid 20-byte 0x wallet address.");
  $("query-button").disabled = true;
  try { const record = await readStatus(wallet); addLog("get_humanity_status", "Successful", record.evaluated ? record.status : "No assessment found"); }
  catch (error) { const message = document.createElement("span"); message.className = "error"; text(message, friendlyError(error, "Unable to read the on-chain assessment.")); $("query-result").replaceChildren(message); $("query-result").classList.add("show"); }
  finally { $("query-button").disabled = false; }
}

async function revoke() {
  const wallet = $("revoke-wallet").value.trim() || state.walletAddress; if (!state.walletReady) return handleWalletError(new Error("Connect your wallet on GenLayer Studionet first.")); if (!validWallet(wallet)) return alert("Enter a valid 20-byte 0x wallet address.");
  $("revoke-button").disabled = true; $("revoke-state").textContent = "Wallet confirmation required"; $("revoke-terminal").replaceChildren();
  try { await submitWrite("revoke_status", [wallet], "revoke-terminal", "revoke-state"); await readStatus(wallet); await readRegistry(); }
  catch (error) { const submitted = error.transactionSubmitted === true; terminal("revoke-terminal", `${submitted ? "transaction failed" : "write not submitted"}: ${friendlyError(error)}`, "error"); $("revoke-state").textContent = submitted ? "Failed" : "Not submitted"; addLog("revoke_status", submitted ? "Failed" : "Not submitted", friendlyError(error)); }
  finally { $("revoke-button").disabled = !state.walletReady; }
}

async function startup() {
  $("contract-pill").textContent = `Contract: ${short(CONTRACT_ADDRESS)}`;
  $("technical-contract").textContent = validWallet(CONTRACT_ADDRESS || "") ? CONTRACT_ADDRESS : "Configure after manual deployment";
  renderRuntimeDiagnostics();
  syncWalletUi(null);
  if (configurationError) { showConfigurationError(); return; }
  try { $("admin").textContent = await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_admin", args: [] }); contractDebug("get_admin = success"); await readRegistry(); }
  catch (error) { $("admin").textContent = "Unavailable"; const message = document.createElement("div"); message.className = "empty error"; text(message, `Unable to read contract: ${friendlyError(error, "Unable to read the deployed contract.")}`); $("registry").replaceChildren(message); }
  await restoreAuthorizedWallet();
}

async function runConnect(button) {
  button.disabled = true; button.textContent = "Connecting…"; setNetwork("Connecting wallet…", "warn");
  try { await connectWallet({ requestAccounts: true, autoSwitch: true }); } catch (error) { await handleWalletError(error); }
  finally { button.disabled = false; if (!state.walletReady) button.textContent = state.walletAddress ? "Switch to Studionet" : "Connect Wallet"; }
}

$("connect-wallet").addEventListener("click", () => runConnect($("connect-wallet")));
$("wallet-state-button").addEventListener("click", () => runConnect($("wallet-state-button")));
$("scan-button").addEventListener("click", scan);
$("scan-extended-button").addEventListener("click", () => scan("extended"));
$("contract-test-button").addEventListener("click", testContractConnection);
$("ev-button").addEventListener("click", evaluate); $("query-button").addEventListener("click", query); $("revoke-button").addEventListener("click", revoke);
if (window.ethereum) { window.ethereum.on?.("accountsChanged", handleAccountsChanged); window.ethereum.on?.("chainChanged", handleChainChanged); }
startup();
