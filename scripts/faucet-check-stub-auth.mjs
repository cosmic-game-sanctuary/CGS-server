// Test-only: lets arc-faucet-check mount the real route without a Privy login.
export const requireAuth = (_req, _res, next) => next();
