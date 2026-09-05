import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { wishlistAgents, games } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { Errors } from "../lib/errors.js";
import { param } from "../lib/params.js";
import { privy } from "../services/privy/client.js";
import { getAccountByEvmAddress } from "../services/hedera/mirror.js";
import { env } from "../config/env.js";

const agentRouter = Router({ caseSensitive: true, strict: true });

const createAgentSchema = z.object({
  targetGameId: z.string().uuid(),
  triggerPriceUnits: z.number().int().nonnegative(),
});

// creates a wallet dedicated to this agent alone — never the buyer's own —
// and returns its address for funding. the wallet's balance is the spending
// cap. there's no policy check because there's nothing else to check.
agentRouter.post(
  "/",
  requireAuth,
  validate(createAgentSchema),
  asyncHandler(async (req, res) => {
    const { targetGameId, triggerPriceUnits } = req.body;
    const game = await db.query.games.findFirst({ where: eq(games.id, targetGameId) });
    if (!game) throw Errors.notFound("Game");

    const wallet = await privy.wallets().create({ chain_type: "ethereum" });

    const [agent] = await db
      .insert(wishlistAgents)
      .values({
        buyerUserId: req.auth!.id,
        agentWalletId: wallet.id,
        agentEvmAddress: wallet.address,
        targetGameId,
        triggerPriceUnits,
      })
      .returning();

    res.status(201).json({ ...agent, fundAddress: wallet.address });
  }),
);

agentRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const agent = await db.query.wishlistAgents.findFirst({
      where: eq(wishlistAgents.id, param(req, "id")),
    });
    if (!agent) throw Errors.notFound("Agent");
    if (agent.buyerUserId !== req.auth!.id) throw Errors.notOwner();

    // the account doesn't exist on Hedera until the address first receives
    // value — a null here just means "not funded yet," not an error.
    const account = await getAccountByEvmAddress(agent.agentEvmAddress);
    if (account && !agent.agentAccountId) {
      await db
        .update(wishlistAgents)
        .set({ agentAccountId: account.account, status: agent.status === "draft" ? "funded" : agent.status })
        .where(eq(wishlistAgents.id, agent.id));
      agent.agentAccountId = account.account;
    }

    // the cap is whatever the wallet actually holds in the settlement asset —
    // nothing else. 0.0.0 means HBAR; anything else is an HTS token balance.
    const balanceUnits =
      env.X402_ASSET === "0.0.0"
        ? account?.balance?.balance ?? null
        : (account?.balance?.tokens.find((t) => t.token_id === env.X402_ASSET)?.balance ?? null);

    res.json({ ...agent, fundAddress: agent.agentEvmAddress, balanceUnits });
  }),
);

export default agentRouter;
