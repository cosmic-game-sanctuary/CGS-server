import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { wishlistAgents, agentDecisions } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError, Errors } from "../lib/errors.js";
import { assetDecimals, ensFullName, toDisplayAmount } from "../lib/display.js";
import { env } from "../config/env.js";
import { createAgent, agentBalance, retireAgent } from "../services/agent/wallet.js";

/**
 * The one agent a person may have. Mounted under /api/me, matching
 * /api/me/wishlist and /api/me/library — there is at most one of these per
 * person, so it is a singular resource, not a collection.
 *
 * What a game wants from this agent — which games, up to what price — is not
 * set here. It lives on the wishlist row it upgrades; see
 * PATCH /api/games/:id/wishlist in game.routes.ts.
 */
const agentRouter = Router({ caseSensitive: true, strict: true });

function serializeAgent(agent: typeof wishlistAgents.$inferSelect, balanceUnits: bigint) {
  return {
    id: agent.id,
    status: agent.status,
    mode: agent.mode,
    onTimeout: agent.onTimeout,
    expiresAt: agent.expiresAt,
    fundAddress: agent.agentEvmAddress,
    agentAccountId: agent.agentAccountId,
    hcs14Aid: agent.hcs14Aid,
    ensLabel: agent.ensLabel,
    ensName: ensFullName(agent.ensLabel),
    ensTxHash: agent.ensTxHash,
    balanceUnits: balanceUnits.toString(),
    balanceUsd: toDisplayAmount(Number(balanceUnits), env.X402_ASSET),
    balanceAsset: env.X402_ASSET,
    balanceAssetDecimals: assetDecimals(env.X402_ASSET),
    createdAt: agent.createdAt,
  };
}

async function requireOwnAgent(userId: string) {
  const agent = await db.query.wishlistAgents.findFirst({ where: eq(wishlistAgents.buyerUserId, userId) });
  if (!agent) throw Errors.notFound("Agent");
  return agent;
}

const createAgentSchema = z.object({
  mode: z.enum(["autonomous", "ask_first"]).default("autonomous"),
  onTimeout: z.enum(["buy", "skip"]).default("buy"),
  /** Omit for no expiry. */
  expiresAt: z.string().datetime().optional(),
  /** Optional: a chosen name, minted the same way a studio subname is. */
  ensLabel: z.string().min(1).max(63).optional(),
});

// Creates a wallet dedicated to this agent alone — never the buyer's own —
// and returns its address for funding. Funding itself is not a route here:
// it is an ordinary withdrawal from the buyer's own wallet with the agent's
// address as the destination — see me.routes.ts#/withdraw/prepare.
agentRouter.post(
  "/",
  requireAuth,
  validate(createAgentSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createAgentSchema>;
    const agent = await createAgent(req.auth!.id, {
      mode: body.mode,
      onTimeout: body.onTimeout,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      ensLabel: body.ensLabel,
    });
    res.status(201).json(serializeAgent(agent, 0n));
  }),
);

agentRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const agent = await requireOwnAgent(req.auth!.id);
    res.json(serializeAgent(agent, await agentBalance(agent)));
  }),
);

const updateAgentSchema = z
  .object({
    mode: z.enum(["autonomous", "ask_first"]).optional(),
    onTimeout: z.enum(["buy", "skip"]).optional(),
    // Explicit null clears an expiry; omit to leave it as it is.
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to change" });

agentRouter.patch(
  "/",
  requireAuth,
  validate(updateAgentSchema),
  asyncHandler(async (req, res) => {
    const agent = await requireOwnAgent(req.auth!.id);
    const body = req.body as z.infer<typeof updateAgentSchema>;

    const fields: Partial<typeof wishlistAgents.$inferInsert> = {};
    if (body.mode !== undefined) fields.mode = body.mode;
    if (body.onTimeout !== undefined) fields.onTimeout = body.onTimeout;
    if (body.expiresAt !== undefined) fields.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

    const [updated] = await db.update(wishlistAgents).set(fields).where(eq(wishlistAgents.id, agent.id)).returning();
    res.json(serializeAgent(updated!, await agentBalance(updated!)));
  }),
);

// Ends the agent and returns whatever is left, in one step — see
// services/agent/wallet.ts#retireAgent for why no browser signature is needed.
agentRouter.delete(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const agent = await requireOwnAgent(req.auth!.id);
    if (agent.status === "cancelled" || agent.status === "expired") {
      throw new AppError(409, "AGENT_ALREADY_RETIRED", "This agent has already ended.");
    }
    const { agent: retired, refundTxId, refundedUnits } = await retireAgent(agent, "cancelled");
    res.json({
      ...serializeAgent(retired, 0n),
      refundTxId,
      refundedUnits: refundedUnits.toString(),
      refundedUsd: toDisplayAmount(Number(refundedUnits), env.X402_ASSET),
    });
  }),
);

// The audit trail — every round the agent has actually acted on. Newest
// first, capped, because this is a history to skim, not to paginate through
// during a demo.
agentRouter.get(
  "/decisions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const agent = await requireOwnAgent(req.auth!.id);
    const rows = await db.query.agentDecisions.findMany({
      where: eq(agentDecisions.agentId, agent.id),
      orderBy: desc(agentDecisions.createdAt),
      limit: 50,
    });
    res.json({ decisions: rows });
  }),
);

export default agentRouter;
