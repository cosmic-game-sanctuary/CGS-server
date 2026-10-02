import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors.js";
import logger from "../utils/logger.utils.js";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}.` },
  });
}

// express only treats this as error-handling middleware because it takes
// four arguments — don't drop `next` even though it's unused.
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction,
) {
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err }, err.message);
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // Errors thrown by middleware we did not write — chiefly express's body
  // parser and multer. They already carry the right status and the caller can
  // act on all of them, so reporting a 413 as "something went wrong on our end"
  // is both a lie and useless: it tells someone whose save is too large to
  // retry, which will fail identically forever.
  const known = asClientError(err);
  if (known) {
    logger.warn({ err, path: req.originalUrl }, known.message);
    res.status(known.status).json({ error: { code: known.code, message: known.message } });
    return;
  }

  // A misconfiguration, not a bug: the chain layer could not be used because
  // something it needs was never set. Reported as such rather than as an
  // opaque 500, because the message names exactly which setting is missing and
  // "Something went wrong on our end" throws that away.
  if (err instanceof Error && (err.name === "ArcConfigError" || err.name === "FacilitatorConfigError")) {
    logger.error({ err, path: req.originalUrl }, "chain configuration is incomplete");
    res.status(503).json({ error: { code: "CHAIN_NOT_CONFIGURED", message: err.message } });
    return;
  }

  logger.error({ err }, "unhandled error");
  res.status(500).json({
    error: { code: "INTERNAL", message: "Something went wrong on our end." },
  });
}

/** A 4xx thrown by third-party middleware, or null if this is genuinely ours. */
function asClientError(err: unknown): { status: number; code: string; message: string } | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { status?: number; statusCode?: number; type?: string; code?: string; message?: string };
  const status = e.status ?? e.statusCode;
  if (typeof status !== "number" || status < 400 || status >= 500) return null;

  if (e.type === "entity.too.large" || e.code === "LIMIT_FILE_SIZE") {
    return { status: 413, code: "PAYLOAD_TOO_LARGE", message: "That upload is larger than this endpoint accepts." };
  }
  if (e.type === "entity.parse.failed") {
    return { status: 400, code: "MALFORMED_JSON", message: "That request body isn't valid JSON." };
  }
  if (typeof e.code === "string" && e.code.startsWith("LIMIT_")) {
    return { status: 400, code: "UPLOAD_REJECTED", message: e.message ?? "That upload was rejected." };
  }
  return { status, code: "BAD_REQUEST", message: e.message ?? "That request could not be processed." };
}
