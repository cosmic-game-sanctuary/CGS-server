import { verifyAccessToken } from "@privy-io/node";
import type { LinkedAccount } from "@privy-io/node";
import { privy } from "./client.js";
import { env } from "../../config/env.js";

export type PrivyIdentity = {
  privyDid: string;
  email: string;
  evmAddress: string;
  privyWalletId: string;
};

// throws if the token is missing, expired, or doesn't verify — callers decide
// what that means (401 for a route that requires it, ignored for one that
// doesn't).
export async function verifyToken(bearerToken: string) {
  return verifyAccessToken({
    access_token: bearerToken,
    app_id: env.PRIVY_APP_ID,
    verification_key: env.PRIVY_VERIFICATION_KEY,
  });
}

// the access token only carries a user id — email and the embedded wallet
// address live on the user object itself.
export async function fetchIdentity(userId: string): Promise<PrivyIdentity> {
  const user = await privy.users()._get(userId);

  const email = findLinkedAccount(user.linked_accounts, "email")?.address;
  const wallet = findLinkedAccount(user.linked_accounts, "ethereum");

  if (!email || !wallet?.id) {
    throw new Error(`Privy user ${userId} is missing an email or an embedded wallet.`);
  }

  return { privyDid: user.id, email, evmAddress: wallet.address, privyWalletId: wallet.id };
}

function findLinkedAccount(
  accounts: LinkedAccount[],
  type: "email" | "ethereum",
): { address: string; id?: string | null } | undefined {
  if (type === "email") {
    return accounts.find((a): a is Extract<LinkedAccount, { type: "email" }> => a.type === "email");
  }
  return accounts.find(
    (a): a is Extract<LinkedAccount, { type: "wallet"; chain_type: "ethereum"; connector_type: "embedded" }> =>
      a.type === "wallet" && "chain_type" in a && a.chain_type === "ethereum" &&
      "connector_type" in a && a.connector_type === "embedded",
  );
}
