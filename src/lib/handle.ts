import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";

// A handle is what shows up on a split line, in a studio's credits, and — since
// profiles exist — in the URL of a person's own page. Everyone who can appear
// in any of those needs a plausible default rather than a blank, and the part
// before the @ is what most people would have picked anyway. That is the same
// rule the invite flow already uses for someone it only knows by email.
export function fallbackHandle(email: string): string {
  const local = email.split("@")[0] ?? "";
  return normaliseHandle(local) || "anon";
}

/**
 * Lowercase, URL-safe, and short enough to print. Lowercased rather than
 * case-preserved because a handle is an address: `Kai` and `kai` being two
 * different people is a phishing surface, not a feature. What someone wants
 * capitalised is their display name, which is a separate field.
 */
export function normaliseHandle(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 30);
}

/**
 * Words that would collide with a route or impersonate the site.
 *
 * Worth having before anyone claims one rather than after: taking a handle back
 * from a real person is a much worse conversation than refusing it once.
 */
const RESERVED = new Set([
  "me", "new", "edit", "admin", "administrator", "settings", "support", "help",
  "about", "api", "cgs", "official", "staff", "moderator", "mod", "system",
  "login", "logout", "signin", "signup", "register", "account", "profile",
  "user", "users", "studio", "studios", "game", "games", "library", "publish",
  "invite", "invites", "agent", "agents", "notifications", "null", "undefined",
  "anon", "anonymous", "root", "everyone", "here",
]);

export function isReservedHandle(handle: string): boolean {
  return RESERVED.has(handle);
}

/**
 * The given handle if nobody has it, otherwise the same with a number on the
 * end. Used when we are *assigning* one — at first sign-in, where refusing
 * would mean refusing the sign-in.
 *
 * When a person is *choosing* one, the collision is theirs to resolve and the
 * route says so rather than silently handing them `kai4`.
 */
export async function allocateHandle(base: string, exceptUserId?: string): Promise<string> {
  const root = normaliseHandle(base) || "player";
  const candidates = [root, ...Array.from({ length: 60 }, (_, i) => `${root}${i + 2}`)];

  for (const candidate of candidates) {
    if (isReservedHandle(candidate)) continue;
    const taken = await db.query.users.findFirst({
      where: eq(users.handle, candidate),
      columns: { id: true },
    });
    if (!taken || taken.id === exceptUserId) return candidate;
  }
  // 60 people called the same thing is not a real scenario, but silently
  // returning a duplicate would break the unique index at insert time.
  return `${root}-${Math.random().toString(36).slice(2, 7)}`;
}
