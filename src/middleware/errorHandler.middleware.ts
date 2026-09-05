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

  logger.error({ err }, "unhandled error");
  res.status(500).json({
    error: { code: "INTERNAL", message: "Something went wrong on our end." },
  });
}
