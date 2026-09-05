// turns "Tin Roof Runner" into "tin-roof-runner". Collisions get a short
// random suffix rather than a counter — good enough at this scale, and it
// means publishing never has to read the table before writing.
export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "untitled";
}

export function withSuffix(slug: string): string {
  return `${slug}-${Math.random().toString(36).slice(2, 6)}`;
}
