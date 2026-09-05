import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { Errors } from "../lib/errors.js";

type Target = "body" | "query" | "params";

// validate(schema) checks req.body by default; validate(schema, "query")
// checks req.query, etc. Replaces req[target] with the parsed (and
// coerced/defaulted) value so handlers get typed, clean input.
//
// req.query is a getter with no setter as of Express 5 (it's recomputed from
// req.url on every read), so a plain `req.query = ...` throws under ESM's
// strict mode. Object.defineProperty swaps the getter for a plain value —
// Express's own getters are all configurable, so this is safe.
export function validate(schema: ZodType, target: Target = "body") {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      next(Errors.validationFailed(result.error.flatten()));
      return;
    }
    if (target === "query") {
      Object.defineProperty(req, "query", { value: result.data, writable: true, configurable: true });
    } else {
      req[target] = result.data;
    }
    next();
  };
}
