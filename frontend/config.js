import { CONTRACT_ADDRESS } from "./contract.js";

export default {
  network: "studionet",
  chainId: 61999,
  contractAddress: CONTRACT_ADDRESS,
  contractSchemaVersion: "2",
  scanMaxBlocks: 50,
  scanExtendedMaxBlocks: 500,
  scanTimeoutMs: 30000,
  scanExtendedTimeoutMs: 60000,
  scanRpcTimeoutMs: 10000,
  scanConcurrency: 5,
  scanBatchSize: 50,
  scanBatchConcurrency: 2,
  scanAdaptiveRanges: [50],
  scanDiagnostics: true,
};
