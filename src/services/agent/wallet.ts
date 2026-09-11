import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { wishlistAgents, users } from "../../db/schema.js";
import { AppError, Errors } from "../../lib/errors.js";
import { env } from "../../config/env.js";
import { privy } from "../privy/client.js";
import { derivePublicKeyHex } from "../privy/signing.js";
import { getAccountByEvmAddress } from "../hedera/mirror.js";
import { refundAgentBalance } from "../wallet/withdraw.js";
import { resolveHederaAccount } from "../users/repo.js";
import { isSubnameAvailable, registerAgentSubname } from "../ens/registrar.js";
import logger from "../../utils/logger.utils.js";

type Agent = typeof wishlistAgents.$inferSelect;

/**
 * Creating and retiring the one agent a person may have.
 *
 * A wallet costs nothing to create (no chain transaction — see
 * wishlist-agent-spec.md §7's cost table) so this always makes one, whether
 * or not a name is requested alongside it.
 */

export type NewAgentInput = {
  mode?: "autonomous" | "ask_first";
  onTimeout?: "buy" | "skip";
  expiresAt?: Date | null;
  /** Optional. Same subregistry and same real availability check a studio
   * subname gets — see services/ens/registrar.ts#registerAgentSubname. */
  ensLabel?: string | null;
};

export async function createAgent(buyerUserId: string, input: NewAgentInput) {
  const existing = await db.query.wishlistAgents.findFirst({
    where: eq(wishlistAgents.buyerUserId, buyerUserId),
  });
  if (existing) {
    throw new AppError(409, "AGENT_EXISTS", "You already have an agent.", { agentId: existing.id });
  }

  // Checked before anything is created — a failure here should cost nothing.
  if (input.ensLabel) {
    const available = await isSubnameAvailable(env.ENS_SUBREGISTRY_ADDRESS as `0x${string}`, input.ensLabel);
    if (!available) {
      throw Errors.validationFailed({ ensLabel: `"${input.ensLabel}" is not available.` });
    }
  }

  const wallet = await privy.wallets().create({ chain_type: "ethereum" });
  // Same reasoning as every other Privy wallet in this codebase: the object
  // Privy hands back has no usable public key, so it is derived from a real
  // signature instead, checked against the address it claims. See
  // services/privy/signing.ts.
  const publicKeyHex = await derivePublicKeyHex(wallet.id, wallet.address);

  let ensTxHash: string | null = null;
  if (input.ensLabel) {
    try {
      ensTxHash = await registerAgentSubname(
        env.ENS_SUBREGISTRY_ADDRESS as `0x${string}`,
        input.ensLabel,
        wallet.address as `0x${string}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, ensLabel: input.ensLabel }, "agent subname mint failed");
      throw new AppError(
        502,
        "ENS_MINT_FAILED",
        "The name could not be claimed on chain. Nothing was created, so you can try again.",
        { reason: message },
      );
    }
  }

  const [agent] = await db
    .insert(wishlistAgents)
    .values({
      buyerUserId,
      agentWalletId: wallet.id,
      agentEvmAddress: wallet.address,
      agentPublicKeyHex: publicKeyHex,
      mode: input.mode ?? "autonomous",
      onTimeout: input.onTimeout ?? "buy",
      expiresAt: input.expiresAt ?? null,
      ensLabel: input.ensLabel ?? null,
      ensTxHash,
    })
    .returning();

  return agent!;
}

/**
 * Give an existing agent a name.
 *
 * Naming is deliberately **not** part of creating one: choosing a name is not
 * a decision anyone should be asked for before their agent exists, and it
 * costs a slow Sepolia write that has no business sitting in the middle of
 * setup. The field was therefore never offered anywhere, which is how an
 * agent could never get a name at all — the route accepted `ensLabel` on
 * create and nothing in the app ever sent it.
 *
 * Once claimed it stays claimed. The name is an ERC-1155 position in a
 * registry we do not control the contents of after the fact, so "rename" is
 * not a thing this can honestly offer: it would mint a second name and leave
 * the first pointing at the same wallet, which is worse than refusing.
 *
 * Same subregistry, same availability check and same failure message a studio
 * subname gets. One flat namespace, so a studio and an agent compete for the
 * same label. See services/ens/registrar.ts.
 */
export async function nameAgent(agent: Agent, label: string): Promise<Agent> {
  if (agent.ensLabel) {
    throw new AppError(
      409,
      "AGENT_ALREADY_NAMED",
      `This agent is already ${agent.ensLabel}. A name is claimed on chain and can't be swapped.`,
    );
  }
  if (agent.status === "cancelled" || agent.status === "expired") {
    throw new AppError(409, "AGENT_ALREADY_RETIRED", "This agent has ended. There is nothing to name.");
  }

  // Checked before anything is spent — a failure here should cost nothing.
  const available = await isSubnameAvailable(env.ENS_SUBREGISTRY_ADDRESS as `0x${string}`, label);
  if (!available) {
    throw Errors.validationFailed({ ensLabel: `"${label}" is not available.` });
  }

  let ensTxHash: string;
  try {
    ensTxHash = await registerAgentSubname(
      env.ENS_SUBREGISTRY_ADDRESS as `0x${string}`,
      label,
      agent.agentEvmAddress as `0x${string}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, ensLabel: label, agentId: agent.id }, "agent subname mint failed");
    throw new AppError(
      502,
      "ENS_MINT_FAILED",
      "The name could not be claimed on chain. Nothing was created, so you can try again.",
      { reason: message },
    );
  }

  // Written only after the mint lands, so the row never claims a name the
  // chain does not agree with.
  const [named] = await db
    .update(wishlistAgents)
    .set({ ensLabel: label, ensTxHash })
    .where(eq(wishlistAgents.id, agent.id))
    .returning();
  return named!;
}

/**
 * The wallet's current balance in the settlement asset, live from the Mirror
 * Node — never cached, same rule as every other balance in this app. Null
 * means the wallet has not received anything yet, which is a normal state for
 * a fresh agent, not an error.
 */
export async function agentBalance(agent: Agent): Promise<bigint> {
  const account = await getAccountByEvmAddress(agent.agentEvmAddress);
  if (!account) return 0n;
  const token = account.balance?.tokens.find((t) => t.token_id === env.X402_ASSET);
  return BigInt(token?.balance ?? 0);
}

/**
 * End an agent and hand back whatever is left, in one server-side action —
 * no browser round trip, because the server already holds this wallet's key.
 * See services/wallet/withdraw.ts#refundAgentBalance for why that is safe here
 * specifically and nowhere else.
 *
 * Idempotent: retiring an agent that is not currently active (already
 * cancelled or expired) is a no-op rather than a second refund attempt — the
 * status update only claims a row that is not already in a terminal state.
 */
export async function retireAgent(
  agent: Agent,
  reason: "cancelled" | "expired",
): Promise<{ agent: Agent; refundTxId: string | null; refundedUnits: bigint }> {
  const [claimed] = await db
    .update(wishlistAgents)
    .set({ status: reason })
    .where(
      and(
        eq(wishlistAgents.id, agent.id),
        inArray(wishlistAgents.status, ["draft", "funded", "watching", "buying"]),
      ),
    )
    .returning();
  if (!claimed) return { agent, refundTxId: null, refundedUnits: 0n };

  const balance = await agentBalance(claimed);
  if (balance <= 0n || !claimed.agentAccountId) {
    return { agent: claimed, refundTxId: null, refundedUnits: 0n };
  }

  const buyer = await db.query.users.findFirst({ where: eq(users.id, claimed.buyerUserId) });
  if (!buyer) return { agent: claimed, refundTxId: null, refundedUnits: 0n };

  const buyerAccountId = await resolveHederaAccount(buyer);
  // The buyer's own wallet has never received anything — genuinely rare (they
  // funded the agent from somewhere else entirely) but not impossible, and
  // there is nowhere to send the refund. Left in the agent's wallet rather
  // than lost; a future retry (or a manual withdrawal once they do have an
  // account) can still move it.
  if (!buyerAccountId) {
    logger.warn({ agentId: claimed.id }, "agent retired but the buyer has no Hedera account to refund to");
    return { agent: claimed, refundTxId: null, refundedUnits: 0n };
  }

  const refundTxId = await refundAgentBalance({
    agentWalletId: claimed.agentWalletId,
    agentPublicKeyHex: claimed.agentPublicKeyHex,
    fromAccountId: claimed.agentAccountId,
    toAccountId: buyerAccountId,
    asset: env.X402_ASSET,
    amountUnits: balance,
  });

  return { agent: claimed, refundTxId, refundedUnits: balance };
}
