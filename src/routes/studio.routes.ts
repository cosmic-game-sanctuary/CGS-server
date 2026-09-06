import { Router } from "express";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { studios, studioMembers, games, users } from "../db/schema.js";
import { requireAuth, optionalAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError, Errors } from "../lib/errors.js";
import logger from "../utils/logger.utils.js";
import { slugify, withSuffix } from "../lib/slug.js";
import { param, isUuid } from "../lib/params.js";
import { ensFullName } from "../lib/display.js";
import { fallbackHandle } from "../lib/handle.js";
import { isSubnameAvailable, registerStudioSubname } from "../services/ens/registrar.js";
import { env } from "../config/env.js";
import { emailStudioInvite } from "../services/email/messages.js";

const studioRouter = Router({ caseSensitive: true, strict: true });

const createStudioSchema = z.object({
  name: z.string().min(1).max(80),
  bio: z.string().max(500).optional(),
  ensSubname: z.string().min(1).max(63).optional(),
  // What the owner is called on a split line. Optional because most people
  // won't be asked for one at creation; the part before the @ is a sane
  // default and they can be credited under it from their first game.
  handle: z.string().min(1).max(40).optional(),
});

studioRouter.post(
  "/",
  requireAuth,
  validate(createStudioSchema),
  asyncHandler(async (req, res) => {
    const { name, bio, ensSubname, handle } = req.body;

    // One studio per account, which is what everything downstream already
    // assumes: /api/me returns a single `studio`, the profile menu links to
    // "your studio", and publishing picks one without asking. Allowing a
    // second would silently make all three pick an arbitrary one.
    const already = await db.query.studios.findFirst({ where: eq(studios.ownerUserId, req.auth!.id) });
    if (already) {
      throw new AppError(409, "STUDIO_EXISTS", "You already have a studio.", {
        studioId: already.id,
        slug: already.slug,
      });
    }

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
    //
    // It is also the slowest thing this API does: a Sepolia write plus a
    // receipt, so ten seconds or more. A caller waiting on it needs to know
    // that a failure here is the chain rather than their input, because the
    // answer is "try again", not "pick another name".
    let ensTxHash: string | null = null;
    if (ensSubname) {
      try {
        ensTxHash = await registerStudioSubname(
          env.ENS_SUBREGISTRY_ADDRESS as `0x${string}`,
          ensSubname,
          req.auth!.evmAddress as `0x${string}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, ensSubname }, "studio subname mint failed");
        throw new AppError(
          502,
          "ENS_MINT_FAILED",
          "The name could not be claimed on chain. Nothing was created, so you can try again.",
          { reason: message },
        );
      }
    }

    const [studio] = await db
      .insert(studios)
      .values({ ownerUserId: req.auth!.id, name, slug, bio, ensSubname })
      .returning();

    // The owner is a member of their own studio. Without this row a brand new
    // studio reports zero people on every listing it publishes, and the owner
    // has no handle to put on their own game's splits — they'd be the one
    // person on the team the credits couldn't name.
    const [ownerMember] = await db
      .insert(studioMembers)
      .values({
        studioId: studio!.id,
        userId: req.auth!.id,
        email: req.auth!.email,
        handle: handle ?? fallbackHandle(req.auth!.email),
        role: "owner",
        acceptedAt: new Date(),
      })
      .returning();

    res.status(201).json({
      ...studio,
      ens: ensFullName(studio!.ensSubname),
      handle: ownerMember!.handle,
      memberCount: 1,
      ownerAddress: req.auth!.evmAddress,
      // So the UI can point at the transaction that claimed the name rather
      // than asking anyone to take it on trust.
      ensTxHash,
    });
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
    // `fullName` so the screen showing this can print the name being claimed
    // without being told the parent separately. It is the same value that
    // comes back on a studio afterwards.
    res.json({ name, fullName: ensFullName(name), available, checkedOnChain: true });
  }),
);

studioRouter.get(
  "/:idOrSlug",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const idOrSlug = param(req, "idOrSlug");
    const studio = await db.query.studios.findFirst({
      where: isUuid(idOrSlug) ? or(eq(studios.id, idOrSlug), eq(studios.slug, idOrSlug)) : eq(studios.slug, idOrSlug),
    });
    if (!studio) throw Errors.notFound("Studio");

    // Owning the studio is what decides whether this page shows unfinished
    // work, so it has to be known before the games are queried.
    const isOwner = req.auth?.id === studio.ownerUserId;

    const [members, studioGames, owner] = await Promise.all([
      db.query.studioMembers.findMany({
        where: eq(studioMembers.studioId, studio.id),
        columns: { id: true, handle: true, role: true, acceptedAt: true, email: true },
      }),
      db.query.games.findMany({
        // A draft is a game its studio hasn't announced — a title and cover
        // they may still be changing — so this page showed strangers work that
        // was never published. The owner still sees everything, which is what
        // makes this the "manage my games" view as well as the public one.
        where: isOwner
          ? eq(games.studioId, studio.id)
          : and(eq(games.studioId, studio.id), eq(games.status, "published")),
        columns: { id: true, slug: true, title: true, coverCid: true, coverSeed: true, status: true },
      }),
      db.query.users.findFirst({
        where: eq(users.id, studio.ownerUserId),
        columns: { evmAddress: true },
      }),
    ]);

    // This page is public, so a member's email can't be. The id is safe and
    // the splits editor needs it to name someone who has no wallet yet; the
    // address is the studio's own, which every listing already shows.

    res.json({
      ...studio,
      // resolved the same way the embedded studio on a game is, so no client
      // has to know the parent name to render one of them.
      ens: ensFullName(studio.ensSubname),
      ownerAddress: owner?.evmAddress ?? null,
      memberCount: members.length,
      members: members.map((m) => ({
        id: m.id,
        handle: m.handle,
        role: m.role,
        acceptedAt: m.acceptedAt,
        ...(isOwner ? { email: m.email } : {}),
      })),
      games: studioGames,
    });
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

    // The invitee has no account, so no notification row can reach them. Mail
    // is the only channel, and without it the invite is a link nobody was
    // handed. Not awaited into the response: the row is what grants the share,
    // and a mail failure must not make the invite look like it failed.
    void emailStudioInvite({
      to: email,
      handle,
      studioName: studio.name,
      inviteId: member!.id,
    });

    res.status(201).json(member);
  }),
);

export default studioRouter;
