import type { NextFunction, Request, Response } from "express";
import { verifyToken, fetchIdentity } from "../services/privy/auth.js";
import { upsertUser } from "../services/users/repo.js";
import { AppError, Errors } from "../lib/errors.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import logger from "../utils/logger.utils.js";

// what every authenticated route sees as req.auth. `id` is ours (the users
// table row), not Privy's DID — that's what foreign keys point at.
export type Auth = {
  id: string;
  privyDid: string;
  email: string;
  evmAddress: string;
  privyWalletId: string;
  // Null until this wallet has signed something. Only the payment path needs
  // it; see services/users/repo.ts#ensureUserPublicKey.
  publicKeyHex: string | null;
  // null until this address completes its own first outgoing transaction —
  // see services/users/repo.ts#resolveHederaAccount, which is what actually
  // resolves and caches this going forward.
  hederaAccountId: string | null;
};

declare global {
  namespace Express {
    interface Request {
      auth?: Auth;
    }
  }
}

async function resolveAuth(req: Request): Promise<Auth | undefined> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;

  const token = header.slice("Bearer ".length);
  const { user_id: privyDid } = await verifyToken(token);
  const identity = await fetchIdentity(privyDid);
  const user = await upsertUser(identity);

  return {
    id: user.id,
    privyDid: user.privyDid,
    email: user.email,
    evmAddress: user.evmAddress,
    privyWalletId: user.privyWalletId,
    publicKeyHex: user.publicKeyHex,
    hederaAccountId: user.hederaAccountId,
  };
}

// browsing never requires a wallet — this only attaches req.auth when a
// valid token is present, and lets the request through either way.
export const optionalAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  try {
    req.auth = await resolveAuth(req);
  } catch (err) {
    // a present-but-bad token on an optional route is the same as no token,
    // but it should still be visible: a catalog that quietly renders signed
    // out because auth is broken looks like it's working.
    logger.debug({ err, path: req.originalUrl }, "ignoring a bad token on an optional route");
    req.auth = undefined;
  }
  next();
});

// buy, publish, review, agent and report routes all need this — a missing or
// invalid token is a real 401 here, not a silent pass-through.
//
// The reason matters, and used to be thrown away: every failure here became
// the same "Sign in required", including the ones where the caller is signed
// in perfectly well and something else is wrong (a Privy account with no
// embedded wallet, a token from a different Privy app, Privy's API being
// down). Those are three different fixes and they looked identical.
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    next(Errors.unauthenticated("No Authorization header was sent."));
    return;
  }

  let auth: Auth | undefined;
  try {
    auth = await resolveAuth(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, path: req.originalUrl }, "auth failed with a token present");

    // A valid token whose Privy user has no embedded wallet is the one failure
    // a caller can actually act on, and it is the likeliest one during setup:
    // the wallet has to be created at login, and an account made before that
    // was configured won't have one.
    if (/embedded wallet|missing an email/i.test(message)) {
      next(
        new AppError(
          401,
          "WALLET_MISSING",
          "This account has no embedded wallet. Sign out, then sign in again to have one created.",
        ),
      );
      return;
    }
    next(Errors.unauthenticated(`Your sign-in could not be verified. ${message}`));
    return;
  }

  if (!auth) {
    next(Errors.unauthenticated());
    return;
  }
  req.auth = auth;
  next();
});
