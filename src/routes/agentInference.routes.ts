import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { wishlistAgents } from "../db/schema.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/errors.js";
import { env } from "../config/env.js";
import { wantsFor } from "../services/agent/decide.js";
import { agentBalance } from "../services/agent/wallet.js";
import { callAgentModel } from "../services/agent/model.js";
import {
  resourceServer,
  ensureInitialized,
  readPaymentHeader,
  decodePaymentPayload,
} from "../services/x402/server.js";
import logger from "../utils/logger.utils.js";

const agentInferenceRouter = Router({ caseSensitive: true, strict: true });

/**
 * "Inference is metered over x402 — the agent pays per verdict"
 * (wishlist-agent-spec.md §8), made real rather than synthetic. Same 402
 * challenge/verify/settle dance as `/api/games/:id/download` — see that
 * handler for the shape this is deliberately copying.
 *
 * No request body. What to decide about is derived entirely from *who paid*:
 * the settled payment names an account, and if that account is a known
 * agent's, its currently eligible wants and its currently held balance are
 * recomputed fresh here rather than trusted from whatever the caller saw a
 * moment earlier — the same reasoning that makes the Mirror Node the only
 * ground truth anywhere else in this app. A client that isn't a known agent
 * gets a clear error after paying a few hundredths of a cent for nothing,
 * which is the same tradeoff `/download`'s owner-override header already
 * makes: identity is checked against `wishlistAgents` after settlement, not
 * before, because a payment is the only thing this route can verify before
 * a payer has proven who they are.
 */
agentInferenceRouter.get(
  "/verdict",
  asyncHandler(async (req, res) => {
    // Refused before any payment terms are offered, not after settling. A
    // deployment with no model configured must never take money for a verdict
    // it cannot produce — the caller falls back to its deterministic plan and
    // is charged nothing.
    if (!env.GROQ_API_KEY) {
      throw new AppError(503, "MODEL_UNAVAILABLE", "No decision model is configured on this server.");
    }

    await ensureInitialized();

    const requirements = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: env.X402_NETWORK,
      payTo: env.X402_PAY_TO,
      price: { asset: env.X402_ASSET, amount: String(env.AGENT_INFERENCE_PRICE_UNITS) },
      maxTimeoutSeconds: 60,
    });

    const resourceInfo = {
      url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
      description: "wishlist agent — one purchase verdict",
      mimeType: "application/json",
    };

    const header = readPaymentHeader(req.headers as Record<string, unknown>);
    if (!header) {
      const paymentRequired = await resourceServer.createPaymentRequiredResponse(
        requirements,
        resourceInfo,
      );
      res.status(402).json(paymentRequired);
      return;
    }

    const payload = decodePaymentPayload(header);
    const matched = resourceServer.findMatchingRequirements(requirements, payload);
    if (!matched) {
      throw new AppError(402, "PAYMENT_REQUIRED", "The payment doesn't match the verdict price.");
    }

    const verification = await resourceServer.verifyPayment(payload, matched);
    if (!verification.isValid) {
      throw new AppError(402, "PAYMENT_REQUIRED", "Payment could not be verified.", {
        reason: verification.invalidReason,
      });
    }

    const settlement = await resourceServer.settlePayment(payload, matched);
    if (!settlement.success) {
      throw new AppError(402, "PAYMENT_REQUIRED", "Payment could not be settled.", {
        reason: settlement.errorReason,
      });
    }

    const payerAccountId = settlement.payer ?? payload.accepted?.payTo;
    const agent = payerAccountId
      ? await db.query.wishlistAgents.findFirst({ where: eq(wishlistAgents.agentAccountId, payerAccountId) })
      : null;
    if (!agent) {
      throw new AppError(403, "NOT_AN_AGENT", "Only a known agent wallet can pay for a verdict.");
    }

    // Both halves, because the question is an allocation one: what the budget
    // is *also* wanted for is what makes spending it a decision at all.
    const { eligible, pending } = await wantsFor(agent);
    const balanceUnits = await agentBalance(agent);

    try {
      const verdict = await callAgentModel({ eligible, pending, balanceUnits, asset: env.X402_ASSET });
      res.json({ verdict, costUnits: env.AGENT_INFERENCE_PRICE_UNITS, settlementTxId: settlement.transaction });
    } catch (err) {
      // The payment already settled — thinking failed, not paying for it. The
      // caller (evaluateAgent) falls back to the deterministic plan either
      // way (rule 7), so this is a logged loss of a few hundredths of a cent,
      // not a stuck agent.
      logger.error({ err, agentId: agent.id }, "agent model call failed after settlement");
      throw new AppError(502, "MODEL_UNAVAILABLE", "Could not get a verdict this round.", {
        settlementTxId: settlement.transaction,
      });
    }
  }),
);

export default agentInferenceRouter;
