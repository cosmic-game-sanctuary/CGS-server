import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { PrivyIdentity } from "../privy/auth.js";

// every route needs our own users.id for foreign keys, not Privy's DID
// directly, so auth always resolves through here. Creates the row on first
// sign-in; updates email/address if they've changed since.
export async function upsertUser(identity: PrivyIdentity) {
  const existing = await db.query.users.findFirst({
    where: eq(users.privyDid, identity.privyDid),
  });

  if (existing) {
    if (existing.email !== identity.email || existing.evmAddress !== identity.evmAddress) {
      const [updated] = await db
        .update(users)
        .set({ email: identity.email, evmAddress: identity.evmAddress })
        .where(eq(users.id, existing.id))
        .returning();
      return updated!;
    }
    return existing;
  }

  const [created] = await db
    .insert(users)
    .values({
      privyDid: identity.privyDid,
      email: identity.email,
      evmAddress: identity.evmAddress,
    })
    .returning();
  return created!;
}
