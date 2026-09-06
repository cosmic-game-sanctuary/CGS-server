import type { Request } from "express";

// Express 5 types every route param as `string | string[]` — to support
// repeated-segment patterns none of our routes actually use. Every dynamic
// segment here is a single value, always.
export function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0]! : value!;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// An `:idOrSlug` route can't compare a slug against a uuid column: Postgres
// casts the bound parameter and throws `invalid input syntax for type uuid`,
// which surfaces as a 500 on every by-slug lookup. Callers use this to only
// include the id branch when the value could actually be one.
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
