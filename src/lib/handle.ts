// A handle is what shows up on a split line and in a studio's credits, so
// everyone who can be on one needs a plausible default rather than a blank.
// The part before the @ is what most people would have picked anyway, which
// is the same rule the invite flow already uses for someone it only knows by
// email (see invite.routes.ts).
export function fallbackHandle(email: string): string {
  const local = email.split("@")[0] ?? "";
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .slice(0, 40);
  return cleaned || "anon";
}
