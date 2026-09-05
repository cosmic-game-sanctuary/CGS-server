import { Router } from "express";
import { eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { studios, studioMembers, games } from "../db/schema.js";
import { requireAuth, optionalAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { Errors } from "../lib/errors.js";
import { slugify, withSuffix } from "../lib/slug.js";
import { param } from "../lib/params.js";

const studioRouter = Router({ caseSensitive: true, strict: true });

const createStudioSchema = z.object({
  name: z.string().min(1).max(80),
  bio: z.string().max(500).optional(),
  ensSubname: z.string().min(1).max(63).optional(),
});

studioRouter.post(
  "/",
  requireAuth,
  validate(createStudioSchema),
  asyncHandler(async (req, res) => {
    const { name, bio, ensSubname } = req.body;

    let slug = slugify(name);
    if (await db.query.studios.findFirst({ where: eq(studios.slug, slug) })) {
      slug = withSuffix(slug);
    }

    const [studio] = await db
      .insert(studios)
      .values({ ownerUserId: req.auth!.id, name, slug, bio, ensSubname })
      .returning();

    res.status(201).json(studio);
  }),
);

// stub for the real check: Stage 7 replaces this with a live Sepolia read
// against the ENS registry. For now it only rules out a name we've already
// stored, which is honest about what it does and doesn't guarantee.
studioRouter.get(
  "/ens-availability",
  validate(z.object({ name: z.string().min(1).max(63) }), "query"),
  asyncHandler(async (req, res) => {
    const { name } = req.query as unknown as { name: string };
    const taken = await db.query.studios.findFirst({ where: eq(studios.ensSubname, name) });
    res.json({ name, available: !taken, checkedOnChain: false });
  }),
);

studioRouter.get(
  "/:idOrSlug",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const idOrSlug = param(req, "idOrSlug");
    const studio = await db.query.studios.findFirst({
      where: or(eq(studios.id, idOrSlug), eq(studios.slug, idOrSlug)),
    });
    if (!studio) throw Errors.notFound("Studio");

    const [members, studioGames] = await Promise.all([
      db.query.studioMembers.findMany({
        where: eq(studioMembers.studioId, studio.id),
        columns: { handle: true, role: true, acceptedAt: true },
      }),
      db.query.games.findMany({
        where: eq(games.studioId, studio.id),
        columns: { id: true, slug: true, title: true, coverCid: true, coverSeed: true, status: true },
      }),
    ]);

    res.json({ ...studio, members, games: studioGames });
  }),
);

const inviteMemberSchema = z.object({
  email: z.string().email(),
  handle: z.string().min(1).max(40),
  role: z.enum(["owner", "member"]).default("member"),
});

studioRouter.post(
  "/:id/members",
  requireAuth,
  validate(inviteMemberSchema),
  asyncHandler(async (req, res) => {
    const studio = await db.query.studios.findFirst({ where: eq(studios.id, param(req, "id")) });
    if (!studio) throw Errors.notFound("Studio");
    if (studio.ownerUserId !== req.auth!.id) throw Errors.notOwner();

    const { email, handle, role } = req.body;
    const [member] = await db
      .insert(studioMembers)
      .values({ studioId: studio.id, email, handle, role })
      .returning();

    res.status(201).json(member);
  }),
);

export default studioRouter;
