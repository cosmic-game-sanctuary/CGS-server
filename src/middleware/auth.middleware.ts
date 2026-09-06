import type { NextFunction, Request, Response } from "express";
import { verifyToken, fetchIdentity } from "../services/privy/auth.js";
import { upsertUser } from "../services/users/repo.js";
import { Errors } from "../lib/errors.js";
import { asyncHandler } from "../lib/asyncHandler.js";

// what every authenticated route sees as req.auth. `id` is ours (the users
// table row), not Privy's DID — that's what foreign keys point at.
export type Auth = {
  id: string;
  privyDid: string;
  email: string;
  evmAddress: string;
  privyWalletId: string;
  publicKeyHex: string;
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
  } catch {
    // a present-but-bad token on an optional route is the same as no token.
    req.auth = undefined;
  }
  next();
});

// buy, publish, review, agent and report routes all need this — a missing or
// invalid token is a real 401 here, not a silent pass-through.
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const auth = await resolveAuth(req).catch(() => undefined);
  if (!auth) {
    next(Errors.unauthenticated());
    return;
  }
  req.auth = auth;
  next();
});
