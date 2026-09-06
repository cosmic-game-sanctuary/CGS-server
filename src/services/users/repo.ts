import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { PrivyIdentity } from "../privy/auth.js";
import { derivePublicKeyHex } from "../privy/signing.js";
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

    const publicKeyHex = walletChanged
      ? await derivePublicKeyHex(identity.privyWalletId)
      : existing.publicKeyHex;

    const [updated] = await db
      .update(users)
      .set({
        email: identity.email,
        evmAddress: identity.evmAddress,
        privyWalletId: identity.privyWalletId,
        publicKeyHex,
      })
      .where(eq(users.id, existing.id))
      .returning();
    return updated!;
  }

  const publicKeyHex = await derivePublicKeyHex(identity.privyWalletId);
  const [created] = await db
    .insert(users)
    .values({
      privyDid: identity.privyDid,
      email: identity.email,
      evmAddress: identity.evmAddress,
      privyWalletId: identity.privyWalletId,
      publicKeyHex,
    })
    .returning();
  return created!;
}

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
