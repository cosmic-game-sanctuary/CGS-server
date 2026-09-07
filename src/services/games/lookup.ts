import { eq, or } from "drizzle-orm";
import { db } from "../../db/client.js";
import { games } from "../../db/schema.js";
import { isUuid } from "../../lib/params.js";

/**
 * A game by id or by slug, wherever a route takes a `:id`.
 *
 * Every route under /api/games/:id/… used to compare the segment straight
 * against a uuid column, so passing a slug made Postgres throw "invalid input
 * syntax for type uuid" and the caller got a 500 for what is really an ordinary
 * lookup. The detail route accepted both and nothing else did, which meant a
 * page holding a slug could read a game but not its reviews.
 */
export function findGameByRef(idOrSlug: string) {
  return db.query.games.findFirst({
    where: isUuid(idOrSlug) ? or(eq(games.id, idOrSlug), eq(games.slug, idOrSlug)) : eq(games.slug, idOrSlug),
  });
}
