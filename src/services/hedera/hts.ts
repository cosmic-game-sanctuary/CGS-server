import { TokenCreateTransaction, TokenType, TokenSupplyType } from "@hiero-ledger/sdk";
import client from "./client.js";
import { env } from "../../config/env.js";

// one NFT collection per game, created at publish. Deliberately no wipe,
// freeze, admin, or pause key — their absence is the ownership claim (see
// cgs-technical.md §11), and it's checkable on HashScan, not just asserted
// here. Treasury is the platform operator, not the studio's own wallet —
// a studio wallet as treasury would mean a sleeping dev blocks every mint
// of their own game.
export async function createGameToken(name: string, symbol: string): Promise<string> {
  const tx = await new TokenCreateTransaction()
    .setTokenName(name)
    .setTokenSymbol(symbol)
    .setTokenType(TokenType.NonFungibleUnique)
    .setSupplyType(TokenSupplyType.Infinite)
    .setInitialSupply(0)
    .setTreasuryAccountId(env.HEDERA_OPERATOR_ID)
    .setSupplyKey(client.operatorPublicKey!)
    .execute(client);

  const receipt = await tx.getReceipt(client);
  if (!receipt.tokenId) throw new Error("token creation returned no id");
  return receipt.tokenId.toString();
}
