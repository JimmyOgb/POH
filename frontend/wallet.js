export const STUDIONET_CHAIN_ID = 61999;
export const STUDIONET_CHAIN_ID_HEX = `0x${STUDIONET_CHAIN_ID.toString(16)}`;

export function isStudionetChain(chainId) {
  return Number.parseInt(String(chainId), 16) === STUDIONET_CHAIN_ID;
}

export function walletError(error, fallback = "Wallet operation failed.") {
  if (error?.code === 4001) return "Wallet request was rejected. Please approve the request to continue.";
  if (error?.code === -32002) return "A wallet request is already pending. Open your wallet to finish it.";
  const message = typeof error?.message === "string" ? error.message.split("\n")[0] : "";
  return message || fallback;
}

export async function connectStudionet({ provider, createClient, chain, requestAccounts = true, autoSwitch = true }) {
  if (!provider) throw new Error("No browser wallet detected. Install or enable MetaMask.");
  const method = requestAccounts ? "eth_requestAccounts" : "eth_accounts";
  const accounts = await provider.request({ method });
  const account = accounts?.[0];
  if (!account) return null;

  let client = createClient({ chain, account, provider });
  let chainId = await provider.request({ method: "eth_chainId" });
  if (!isStudionetChain(chainId)) {
    if (!autoSwitch) return { account, chainId, client, ready: false };
    await client.connect("studionet");
    chainId = await provider.request({ method: "eth_chainId" });
    if (!isStudionetChain(chainId)) throw new Error("Please switch your wallet to GenLayer Studionet to continue.");
    client = createClient({ chain, account, provider });
  }
  return { account, chainId, client };
}
