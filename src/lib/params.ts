import type { Request } from "express";

// Express 5 types every route param as `string | string[]` — to support
// repeated-segment patterns none of our routes actually use. Every dynamic
// segment here is a single value, always.
export function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0]! : value!;
}
