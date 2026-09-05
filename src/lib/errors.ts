// every error response in this API has the same shape:
// { error: { code, message, details? } }

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  unauthenticated: (message = "Sign in required.") =>
    new AppError(401, "UNAUTHENTICATED", message),

  notOwner: (message = "You don't have permission to do that.") =>
    new AppError(403, "NOT_OWNER", message),

  notFound: (what: string) => new AppError(404, "NOT_FOUND", `${what} not found.`),

  validationFailed: (details: unknown) =>
    new AppError(422, "VALIDATION_FAILED", "That request doesn't look right.", details),

  walletNotFunded: (message = "This wallet hasn't received anything on Hedera yet.") =>
    new AppError(409, "WALLET_NOT_FUNDED", message),

  gameNotPublished: (message = "This game isn't published.") =>
    new AppError(409, "GAME_NOT_PUBLISHED", message),

  splitsLocked: (message = "Splits lock at publish and can't be changed.") =>
    new AppError(409, "SPLITS_LOCKED", message),

  // a feature whose route exists but whose chain-dependent work belongs to a
  // later stage. real 501, not a silent stub, so hitting it tells you the truth.
  notImplemented: (stage: string) =>
    new AppError(501, "NOT_IMPLEMENTED", `Not built yet — this is ${stage}.`),
};
