import { env } from "../../config/env.js";

// the read API. consensus nodes take writes, mirror nodes serve reads — this
// is ground truth for anything we need to verify actually happened. never
// trust an SDK response over this.
const BASE = env.HEDERA_MIRROR_URL;

async function getJson<T>(path: string): Promise<T | null> {
  const res = await fetch(`${BASE}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`mirror node ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export type MirrorTransaction = {
  transaction_id: string;
  result: string;
  consensus_timestamp: string;
};

// the SDK gives transaction ids as "0.0.x@seconds.nanos"; the mirror node's
// URLs want "0.0.x-seconds-nanos".
function toMirrorTransactionId(sdkTransactionId: string): string {
  const [account, validStart] = sdkTransactionId.split("@");
  return `${account}-${validStart!.replace(".", "-")}`;
}

export async function getTransaction(sdkTransactionId: string) {
  const data = await getJson<{ transactions: MirrorTransaction[] }>(
    `/api/v1/transactions/${toMirrorTransactionId(sdkTransactionId)}`,
  );
  return data?.transactions[0] ?? null;
}

export type MirrorAccount = {
  account: string; // "0.0.x"
  evm_address: string;
  balance: {
    balance: number; // tinybars if the account holds HBAR
    tokens: { token_id: string; balance: number }[];
  } | null;
};

// a Privy embedded wallet is a real EVM address from the moment it's
// created, but it has no Hedera account until it first receives value — a
// 404 here means "not funded yet," not an error.
export async function getAccountByEvmAddress(evmAddress: string) {
  return getJson<MirrorAccount>(`/api/v1/accounts/${evmAddress}`);
}

export type MirrorTopicMessage = {
  consensus_timestamp: string;
  message: string; // base64
  sequence_number: number;
  topic_id: string;
};

// pass the last sequence number you've already processed; returns only what
// came after it, oldest first. this is the agent watcher's whole read path.
export async function getTopicMessages(topicId: string, afterSequenceNumber = 0) {
  const data = await getJson<{ messages: MirrorTopicMessage[] }>(
    `/api/v1/topics/${topicId}/messages?sequencenumber=gt:${afterSequenceNumber}&order=asc&limit=100`,
  );
  return data?.messages ?? [];
}

export type MirrorNft = {
  token_id: string;
  serial_number: number;
  account_id: string;
};

export async function pingMirror(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/v1/network/nodes?limit=1`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function getNftsForAccount(accountId: string, tokenId: string) {
  const data = await getJson<{ nfts: MirrorNft[] }>(
    `/api/v1/accounts/${accountId}/nfts?token.id=${tokenId}`,
  );
  return data?.nfts ?? [];
}
