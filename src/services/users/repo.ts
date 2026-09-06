import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { PrivyIdentity } from "../privy/auth.js";
import { getAccountByEvmAddress } from "../hedera/mirror.js";

// every route needs our own users.id for foreign keys, not Privy's DID
// directly, so auth always resolves through here. Creates the row on first
// sign-in; updates the identity fields if any changed since.
//
// The public key is derived via a real Privy signing call (see
// services/privy/signing.ts — Privy's own wallet objects don't actually
// return one), so it's only ever derived once per wallet and cached here,
// not re-derived on every request.
export async function upsertUser(identity: PrivyIdentity) {
  const existing = await db.query.users.findFirst({
    where: eq(users.privyDid, identity.privyDid),
  });

  if (existing) {
    const walletChanged = existing.privyWalletId !== identity.privyWalletId;
    const identityChanged = existing.email !== identity.email || existing.evmAddress !== identity.evmAddress;

    if (!walletChanged && !identityChanged) return existing;

    const [updated] = await db
      .update(users)
      .set({
        email: identity.email,
        evmAddress: identity.evmAddress,
        privyWalletId: identity.privyWalletId,
        // a different wallet has a different key, and the old one is now
        // wrong rather than merely stale — drop it and re-derive on demand.
        ...(walletChanged ? { publicKeyHex: null } : {}),
      })
      .where(eq(users.id, existing.id))
      .returning();
    return updated!;
  }

  const [created] = await db
    .insert(users)
    .values({
      privyDid: identity.privyDid,
      email: identity.email,
      evmAddress: identity.evmAddress,
      privyWalletId: identity.privyWalletId,
    })
    .returning();
  return created!;
}

// `users.public_key_hex` is nullable and, for a person, never written any more.
//
// It was cached here because paying needed it, and getting it meant asking the
// wallet to sign something — which needs authority over that wallet that this
// server does not have and should not ask for. The buyer's key is recovered
// from the payment signature now (services/privy/signing.ts#publicKeyForAddress),
// which costs nothing, needs no permission, and works for the hollow accounts
// that most buyers actually have. The column stays for the agent's wallets,
// which we create and can sign with.

// The exact behaviour docs/api-contract.md §2 has described since Stage 1 and
// nothing ever actually implemented: return the cached hedera_account_id with
// no network call if we already have one, otherwise resolve it against the
// Mirror Node once and cache it. A 404 there is a normal "not funded yet"
// answer, not an error — every caller that needs a 0.0.x should go through
// this instead of re-deriving the same lookup locally.
export async function resolveHederaAccount(user: {
  id: string;
  evmAddress: string;
  hederaAccountId: string | null;
}): Promise<string | null> {
  if (user.hederaAccountId) return user.hederaAccountId;

  const account = await getAccountByEvmAddress(user.evmAddress);
  if (!account) return null;

  await db.update(users).set({ hederaAccountId: account.account }).where(eq(users.id, user.id));
  return account.account;
}
