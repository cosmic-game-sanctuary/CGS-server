import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AccountId, Hbar, TokenId, TransferTransaction } from "@hiero-ledger/sdk";
import { db } from "../db/client.js";
import { wishlistAgents } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError, Errors } from "../lib/errors.js";
import { env } from "../config/env.js";
import client from "../services/hedera/client.js";
import { balanceOf, getAccount, getAccountByEvmAddress } from "../services/hedera/mirror.js";
import { toDisplayAmount } from "../lib/display.js";
import logger from "../utils/logger.utils.js";

// Development only. Mounted by index.ts solely when DEV_FAUCET=on, and the
// env schema refuses to let that be `on` in production.
//
// Why this has to exist: a Privy embedded wallet is a real EVM address the
// moment someone logs in, but it has no Hedera account at all until it first
// receives value — so a brand new buyer can't be paid to, can't hold a
// GameKey, and can't buy anything. There is no faucet that hands out testnet
// USDC to an arbitrary address, and the browser can't move funds because
// Privy holds the key. The operator account already holds the settlement
// asset (it's where every split payout is paid from), so it is the only
// thing that can put a first balance in a test wallet.
const devRouter = Router({ caseSensitive: true, strict: true });

const faucetSchema = z.object({
  /** Top up the caller's own wallet, or an agent's. */
  target: z.enum(["me", "agent"]).default("me"),
  agentId: z.string().uuid().optional(),
  /** Settlement asset, whole units. Defaults to DEV_FAUCET_AMOUNT. */
  amount: z.number().positive().max(1000).optional(),
});

devRouter.post(
  "/faucet",
  requireAuth,
  validate(faucetSchema),
  asyncHandler(async (req, res) => {
    const { target, agentId, amount } = req.body as z.infer<typeof faucetSchema>;

    let evmAddress = req.auth!.evmAddress;
    if (target === "agent") {
      if (!agentId) throw Errors.validationFailed({ agentId: "required when target is agent" });
      const agent = await db.query.wishlistAgents.findFirst({ where: eq(wishlistAgents.id, agentId) });
      if (!agent) throw Errors.notFound("Agent");
      if (agent.buyerUserId !== req.auth!.id) throw Errors.notOwner();
      evmAddress = agent.agentEvmAddress;
    }

    const units = Math.round((amount ?? env.DEV_FAUCET_AMOUNT) * 10 ** env.X402_ASSET_DECIMALS);
    const alias = AccountId.fromEvmAddress(0, 0, evmAddress);

    // Checked before anything moves. The chain's own answer for this is
    // INSUFFICIENT_TOKEN_BALANCE on a receipt, which says nothing about how
    // much there is or how much was asked for — and by then the HBAR has
    // already been spent creating the account.
    const operator = await getAccount(env.HEDERA_OPERATOR_ID);
    const available = balanceOf(operator, env.X402_ASSET);
    if (available < units) {
      throw new AppError(
        409,
        "FAUCET_EMPTY",
        `The operator holds ${toDisplayAmount(available, env.X402_ASSET)} and this asked for ` +
          `${toDisplayAmount(units, env.X402_ASSET)}. Ask for less, or top up ${env.HEDERA_OPERATOR_ID}.`,
        { availableUnits: String(available), requestedUnits: String(units) },
      );
    }

    // Two steps, in this order, because a token can only reach an account
    // that exists. An HBAR transfer to an unknown alias is what creates one
    // (and the resulting account has unlimited auto-association under
    // HIP-904, so the token needs no association step afterwards).
    const existing = await getAccountByEvmAddress(evmAddress);
    if (!existing) {
      const hbar = new Hbar(env.DEV_FAUCET_HBAR);
      await execute(
        new TransferTransaction()
          .addHbarTransfer(env.HEDERA_OPERATOR_ID, hbar.negated())
          .addHbarTransfer(alias, hbar),
        "creating the account",
      );
    }

    // HBAR is the settlement asset only in the fallback configuration; the
    // transfer above already delivered it, so there's nothing more to send.
    if (env.X402_ASSET !== "0.0.0") {
      const accountId = existing ? AccountId.fromString(existing.account) : await waitForAccount(evmAddress);
      const tokenId = TokenId.fromString(env.X402_ASSET);
      await execute(
        new TransferTransaction()
          .addTokenTransfer(tokenId, env.HEDERA_OPERATOR_ID, -units)
          .addTokenTransfer(tokenId, accountId, units),
        "sending the test balance",
      );
    }

    // Read the result back rather than reporting what we asked for. The
    // mirror node lags a beat behind consensus, so this can legitimately
    // still show the old figure — the client re-reads /api/me anyway.
    const after = await getAccountByEvmAddress(evmAddress);
    const balanceUnits =
      env.X402_ASSET === "0.0.0"
        ? (after?.balance?.balance ?? 0)
        : (after?.balance?.tokens.find((t) => t.token_id === env.X402_ASSET)?.balance ?? 0);

    res.json({
      address: evmAddress,
      accountId: after?.account ?? null,
      sentUnits: String(units),
      balanceUnits: String(balanceUnits),
      balanceUsd: toDisplayAmount(balanceUnits, env.X402_ASSET),
    });
  }),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function execute(tx: any, what: string) {
  try {
    const response = await tx.execute(client);
    await response.getReceipt(client);
  } catch (err) {
    logger.error({ err }, `faucet failed while ${what}`);
    const message = err instanceof Error ? err.message : String(err);
    // INSUFFICIENT_TOKEN_BALANCE on the operator is the one failure worth
    // naming, because the fix is topping up the operator, not retrying.
    throw new AppError(502, "FAUCET_FAILED", `The faucet failed while ${what}. ${message}`);
  }
}

// Consensus is instant, the mirror node is a second or two behind, and the
// account id only exists on the mirror side. Nothing else in the codebase
// waits on this because nothing else creates an account.
async function waitForAccount(evmAddress: string, tries = 12): Promise<AccountId> {
  for (let i = 0; i < tries; i++) {
    const account = await getAccountByEvmAddress(evmAddress);
    if (account) return AccountId.fromString(account.account);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new AppError(
    504,
    "FAUCET_FAILED",
    "The account was created but hasn't appeared on the mirror node yet. Try again in a moment.",
  );
}

export default devRouter;
