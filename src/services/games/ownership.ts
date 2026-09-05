import { getAccountByEvmAddress, getNftsForAccount } from "../hedera/mirror.js";

// the only correct way to answer "does this wallet own this game" — checked
// against the mirror node every time, never against the GameKey cache table.
// a game with no hts_token_id yet (not published, or published before Stage 2
// mints one) can never be owned, which is the right answer, not a bug.
export async function ownsGame(evmAddress: string, htsTokenId: string | null) {
  if (!htsTokenId) return { owned: false as const };

  const account = await getAccountByEvmAddress(evmAddress);
  if (!account) return { owned: false as const }; // wallet not funded yet -> owns nothing

  const nfts = await getNftsForAccount(account.account, htsTokenId);
  if (nfts.length === 0) return { owned: false as const };

  return { owned: true as const, serial: nfts[0]!.serial_number };
}
