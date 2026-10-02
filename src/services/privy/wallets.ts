import { getAddress, type Address } from "viem";
import { privy } from "./client.js";
import logger from "../../utils/logger.utils.js";

/**
 * An EVM address for someone who has never signed in.
 *
 * This exists because of a collision between two things the product promises.
 * A collaborator can be added to a game's splits by email alone — "anyone
 * invited by email is on the splits from the first sale whether or not they've
 * accepted" — and a game's split is fixed forever in a contract at publish. A
 * contract cannot name a person; it names an address. So either an unaccepted
 * invite blocks the publish, or we hold their share for them and hand it over
 * later, which is the custody this whole project exists to avoid.
 *
 * Privy resolves it: it will pre-generate an embedded wallet for an email
 * address before that person ever logs in, and they take control of it the
 * first time they sign in with that email. The address is real from the moment
 * the invite is written, so the vault can name them, nobody is holding anything
 * for anyone, and the publish is never blocked on someone else reading their
 * mail.
 *
 * Docs: https://docs.privy.io/api-reference/users/create
 */

const EMBEDDED_ETHEREUM = (user: unknown): Address | null => {
  const accounts = (user as { linked_accounts?: { type?: string; chain_type?: string; address?: string }[] })
    .linked_accounts;
  const wallet = (accounts ?? []).find((a) => a.type === "wallet" && a.chain_type === "ethereum" && a.address);
  return wallet ? getAddress(wallet.address!) : null;
};

async function findByEmail(email: string): Promise<unknown | null> {
  try {
    return await privy.users().getByEmailAddress({ address: email });
  } catch (err) {
    // Privy answers "no such user" with an error rather than a null, and that
    // is the ordinary case here — most invited collaborators are new. Anything
    // else is a real failure and must not be swallowed into "create a second
    // account for them".
    const message = err instanceof Error ? err.message : String(err);
    if (/404|not.?found|no user/i.test(message)) return null;
    throw err;
  }
}

/**
 * The address a share for `email` should be paid to, creating the wallet if
 * this person has never been seen before.
 *
 * Idempotent, and deliberately so: it is called while resolving a game's
 * splits, which happens on every draft save as well as at publish, and it must
 * return the same address every time or a republished game would pay a
 * different wallet than the draft showed.
 */
export async function addressForEmail(email: string): Promise<Address> {
  const normalised = email.trim().toLowerCase();

  const existing = await findByEmail(normalised);
  if (existing) {
    const address = EMBEDDED_ETHEREUM(existing);
    if (address) return address;

    // A Privy account with no Ethereum wallet — possible for one created
    // before wallets were pre-generated. Give it one rather than refusing.
    const id = (existing as { id: string }).id;
    const updated = await privy.users().pregenerateWallets(id, { wallets: [{ chain_type: "ethereum" }] });
    const made = EMBEDDED_ETHEREUM(updated);
    if (!made) throw new Error(`Privy user ${id} has no Ethereum wallet and one could not be pre-generated`);
    logger.info({ privyDid: id }, "pre-generated a wallet for an existing Privy user with none");
    return made;
  }

  try {
    const created = await privy.users().create({
      linked_accounts: [{ address: normalised, type: "email" }],
      wallets: [{ chain_type: "ethereum" }],
    });
    const address = EMBEDDED_ETHEREUM(created);
    if (!address) throw new Error(`Privy created a user for ${normalised} without the wallet that was asked for`);
    logger.info({ privyDid: (created as { id: string }).id }, "pre-generated a wallet for an invited collaborator");
    return address;
  } catch (err) {
    // Two drafts resolving the same new collaborator at once: one create wins
    // and the other is told the account already exists. Re-read rather than
    // fail, since the address the winner made is the right answer for both.
    const message = err instanceof Error ? err.message : String(err);
    if (!/already|exists|conflict|409/i.test(message)) throw err;

    const raced = await findByEmail(normalised);
    const address = raced ? EMBEDDED_ETHEREUM(raced) : null;
    if (!address) throw err;
    return address;
  }
}
