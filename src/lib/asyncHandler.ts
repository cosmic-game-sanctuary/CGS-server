import type { NextFunction, Request, Response } from "express";

// express 5 forwards rejected promises to error middleware on its own for
// route handlers, but this project also uses it for the odd async middleware
// (auth), where that doesn't apply. cheap enough to use everywhere for
// consistency.
type AsyncFn = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function asyncHandler(fn: AsyncFn) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
