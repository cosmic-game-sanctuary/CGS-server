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
import { isSubnameAvailable, registerStudioSubname } from "../services/ens/registrar.js";
import { env } from "../config/env.js";

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

    // checked live against the subregistry, not just our own table — a
    // label could be taken on-chain without ever passing through this route
    // (e.g. minted directly against the subregistry by hand).
    if (ensSubname && !(await isSubnameAvailable(env.ENS_SUBREGISTRY_ADDRESS as `0x${string}`, ensSubname))) {
      throw Errors.validationFailed({ ensSubname: `"${ensSubname}" is not available.` });
    }

    let slug = slugify(name);
    if (await db.query.studios.findFirst({ where: eq(studios.slug, slug) })) {
      slug = withSuffix(slug);
    }

    // real subname mint — one transaction, no commit-reveal (that's only
    // for the one-time parent name registration). Runs before the insert so
    // a chain failure never leaves a studio row claiming a subname it
    // doesn't actually hold.
    if (ensSubname) {
      await registerStudioSubname(
        env.ENS_SUBREGISTRY_ADDRESS as `0x${string}`,
        ensSubname,
        req.auth!.evmAddress as `0x${string}`,
      );
    }

    const [studio] = await db
      .insert(studios)
      .values({ ownerUserId: req.auth!.id, name, slug, bio, ensSubname })
      .returning();

    res.status(201).json(studio);
  }),
);

// Checked twice, deliberately: our own table first (cheap, catches almost
// every real collision) and then live against the subregistry (source of
// truth — a label minted by hand, outside this route, would only show up
// here). See services/ens/registrar.ts#isSubnameAvailable for how the live
// check works with no dedicated view function to call.
studioRouter.get(
  "/ens-availability",
  validate(z.object({ name: z.string().min(1).max(63) }), "query"),
  asyncHandler(async (req, res) => {
    const { name } = req.query as unknown as { name: string };
    const takenLocally = await db.query.studios.findFirst({ where: eq(studios.ensSubname, name) });
    const available = !takenLocally && (await isSubnameAvailable(env.ENS_SUBREGISTRY_ADDRESS as `0x${string}`, name));
    res.json({ name, available, checkedOnChain: true });
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
