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

// The public key, derived once and cached.
//
// This used to happen inside upsertUser, which meant every sign-in made a real
// signing call against the user's wallet. Two things wrong with that. It put a
// chain-adjacent round trip in front of every first login; and the server can
// only sign with a *user's* embedded wallet after that user has delegated it,
// so an account that hadn't would fail `requireAuth` outright — unable to
// browse signed in, let alone reach the screen where delegation is offered.
//
// Only the payment path actually needs this, so only the payment path pays for
// it. Wallets the server created itself (an agent's) can always sign, which is
// why that path never hit this.
export async function ensureUserPublicKey(user: {
  id: string;
  privyWalletId: string;
  publicKeyHex: string | null;
}): Promise<string> {
  if (user.publicKeyHex) return user.publicKeyHex;

  const publicKeyHex = await derivePublicKeyHex(user.privyWalletId);
  await db.update(users).set({ publicKeyHex }).where(eq(users.id, user.id));
  return publicKeyHex;
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
