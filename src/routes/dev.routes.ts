import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Address } from "viem";
import { db } from "../db/client.js";
import { wishlistAgents } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError, Errors } from "../lib/errors.js";
import { env } from "../config/env.js";
import {
  arcChain,
  confirm,
  feeOverrides,
  operator,
  unitsToWei,
  USDC_ADDRESS,
  walletClient,
} from "../services/arc/client.js";
import { getUsdcUnits } from "../services/arc/reads.js";
import { toDisplayAmount } from "../lib/display.js";
import logger from "../utils/logger.utils.js";

// Development only. Mounted by index.ts solely when DEV_FAUCET=on, and the env
// schema refuses to let that be `on` in production.
//
// Why it still has to exist: Circle's faucet hands out testnet USDC to an
// address you control, not to an arbitrary test buyer's, and the browser cannot
// move funds because Privy holds the key. The operator already holds USDC, so it
// is the only thing that can put a first balance in a test wallet.
//
// **Much simpler than its Hedera version.** There is no account to create first,
// no token to associate, and no second asset for fees: an address can receive
// from the moment it exists, and the USDC it receives is also what pays for its
// own transactions. One transfer, and the wallet is ready to buy something.
const devRouter = Router({ caseSensitive: true, strict: true });

const faucetSchema = z.object({
  /** Top up the caller's own wallet, or an agent's. */
  target: z.enum(["me", "agent"]).default("me"),
  agentId: z.string().uuid().optional(),
  /** Whole USDC. Defaults to DEV_FAUCET_AMOUNT. */
  amount: z.number().positive().max(1000).optional(),
});

devRouter.post(
  "/faucet",
  requireAuth,
  validate(faucetSchema),
  asyncHandler(async (req, res) => {
    const { target, agentId, amount } = req.body as z.infer<typeof faucetSchema>;

    let recipient = req.auth!.evmAddress as Address;
    if (target === "agent") {
      if (!agentId) throw Errors.validationFailed({ agentId: "required when target is agent" });
      const agent = await db.query.wishlistAgents.findFirst({ where: eq(wishlistAgents.id, agentId) });
      if (!agent) throw Errors.notFound("Agent");
      if (agent.buyerUserId !== req.auth!.id) throw Errors.notOwner();
      recipient = agent.agentEvmAddress as Address;
    }

    const units = BigInt(Math.round((amount ?? env.DEV_FAUCET_AMOUNT) * 1_000_000));

    // Checked before anything moves, so an empty operator says so in units
    // rather than failing mid-transfer.
    const available = await getUsdcUnits(operator().address);
    if (available < units) {
      throw new AppError(
        409,
        "FAUCET_EMPTY",
        `The operator holds ${toDisplayAmount(Number(available), USDC_ADDRESS)} and this asked for ` +
          `${toDisplayAmount(Number(units), USDC_ADDRESS)}. Ask for less, or top up ${operator().address}.`,
        { availableUnits: String(available), requestedUnits: String(units) },
      );
    }

    try {
      const hash = await walletClient().sendTransaction({
        account: operator(),
        chain: arcChain(),
        to: recipient,
        value: unitsToWei(units),
        ...(await feeOverrides()),
      });
      await confirm(hash);

      // Read the result back rather than reporting what we asked for.
      const balanceUnits = await getUsdcUnits(recipient);
      res.json({
        address: recipient,
        transactionId: hash,
        sentUnits: String(units),
        balanceUnits: String(balanceUnits),
        balanceUsd: toDisplayAmount(Number(balanceUnits), USDC_ADDRESS),
      });
    } catch (err) {
      logger.error({ err, recipient }, "faucet transfer failed");
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError(502, "FAUCET_FAILED", `The faucet failed. ${message}`);
    }
  }),
);

export default devRouter;
