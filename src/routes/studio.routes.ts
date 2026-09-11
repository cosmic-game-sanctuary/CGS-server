import { Router } from "express";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { studios, studioMembers, games, users, wishlistAgents } from "../db/schema.js";
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
import { studioEarnings } from "../services/earnings/report.js";
import { isStudioMember, canManageStudio, isStudioOwner } from "../services/studios/access.js";
import { authorSummaries } from "../services/users/profile.js";
import {
  removeMember,
  leaveStudio,
  changeMemberRole,
  resendInvite,
  transferOwnership,
} from "../services/studios/membership.js";

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

// Answers for the **whole namespace**, not just studios, despite the path.
// Studio and agent subnames are minted into one flat subregistry, so a label
// either exists under `cgs-sanctuary.eth` or it does not, and there is one
// answer to give. The path stays where it is because it is what the client
// already calls; the agent naming field calls the same route.
//
// Checked twice, deliberately: our own tables first (cheap, catches almost
// every real collision) and then live against the subregistry (source of
// truth — a label minted by hand, outside this route, would only show up
// here). See services/ens/registrar.ts#isSubnameAvailable for how the live
// check works with no dedicated view function to call.
studioRouter.get(
  "/ens-availability",
  validate(z.object({ name: z.string().min(1).max(63) }), "query"),
  asyncHandler(async (req, res) => {
    const { name } = req.query as unknown as { name: string };
    const [studioHas, agentHas] = await Promise.all([
      db.query.studios.findFirst({ where: eq(studios.ensSubname, name), columns: { id: true } }),
      db.query.wishlistAgents.findFirst({ where: eq(wishlistAgents.ensLabel, name), columns: { id: true } }),
    ]);
    const takenLocally = studioHas !== undefined || agentHas !== undefined;
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

    // Being *on the team* is what decides whether this page shows unfinished
    // work — not owning it. A collaborator credited on a game they helped make
    // could not see it before this, which is the wrong side of the line to put
    // them on. Ownership still gates the members' email addresses below.
    const isOwner = req.auth?.id === studio.ownerUserId;
    const onTheTeam = isOwner || (await isStudioMember(studio.id, req.auth?.id));

    const [members, studioGames, owner] = await Promise.all([
      // Active roster only. Someone who left keeps every credit they earned —
      // that lives permanently in `splits`, untouched by this — they just stop
      // appearing here as part of the working team.
      db.query.studioMembers.findMany({
        where: and(eq(studioMembers.studioId, studio.id), eq(studioMembers.active, true)),
        columns: { id: true, handle: true, role: true, acceptedAt: true, email: true, userId: true },
      }),
      db.query.games.findMany({
        // A draft is a game its studio hasn't announced — a title and cover
        // they may still be changing — so this page showed strangers work that
        // was never published. The owner still sees everything, which is what
        // makes this the "manage my games" view as well as the public one.
        where: onTheTeam
          ? eq(games.studioId, studio.id)
          : and(eq(games.studioId, studio.id), eq(games.status, "published")),
        columns: { id: true, slug: true, title: true, coverCid: true, coverSeed: true, status: true },
      }),
      db.query.users.findFirst({
        where: eq(users.id, studio.ownerUserId),
        columns: { evmAddress: true },
      }),
    ]);

    const memberProfiles = await authorSummaries(
      members.map((m) => m.userId).filter((id): id is string => id !== null),
    );

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
      // The one thing a viewer is allowed to know about *which* row is theirs
      // without anyone's userId ever leaving this route. Without it, the
      // client's only option was rendering the same manage-controls block on
      // every row whenever the viewer could manage the team at all — which
      // put "Remove" and "Hand over" on the viewer's own row, pointed at
      // themselves. Null for a stranger, or someone on the team by a row this
      // query didn't return (removed/left, which is `active: false`, or
      // simply not a member here at all).
      viewerMemberId: req.auth ? (members.find((m) => m.userId === req.auth!.id)?.id ?? null) : null,
      members: members.map((m) => ({
        id: m.id,
        handle: m.handle,
        role: m.role,
        acceptedAt: m.acceptedAt,
        // Null for anyone who was invited by email and hasn't signed in. That
        // is a real state, not a gap: they are on the team and on the splits
        // already, they just have no page yet.
        profile: m.userId ? (memberProfiles.get(m.userId) ?? null) : null,
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
    // Manager, not strictly the founder — inviting a collaborator is exactly
    // the kind of team decision the manager role exists to allow. See
    // services/studios/access.ts.
    if (!(await canManageStudio(studio.id, req.auth!.id))) throw Errors.notOwner();

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

// --- managing the roster ----------------------------------------------------
//
// Everything below is new. A studio used to be write-once the same way a game
// was: no way to remove a member, correct a role, resend a lost invite, leave
// a team, or hand off the studio if the founder moves on. All of it is
// deliberately separate from `splits` — see services/studios/membership.ts for
// why that separation is what makes "remove a member" safe at all.

studioRouter.delete(
  "/:id/members/:memberId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const studioId = param(req, "id");
    if (!(await canManageStudio(studioId, req.auth!.id))) throw Errors.notOwner();
    const result = await removeMember(studioId, param(req, "memberId"));
    res.json({
      outcome: result.outcome,
      member: { id: result.member.id, handle: result.member.handle, active: result.member.active },
    });
  }),
);

studioRouter.post(
  "/:id/leave",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await leaveStudio(param(req, "id"), req.auth!.id);
    res.json({
      outcome: result.outcome,
      member: { id: result.member.id, handle: result.member.handle, active: result.member.active },
    });
  }),
);

const roleSchema = z.object({ role: z.enum(["owner", "member"]) });

studioRouter.patch(
  "/:id/members/:memberId",
  requireAuth,
  validate(roleSchema),
  asyncHandler(async (req, res) => {
    const studioId = param(req, "id");
    if (!(await canManageStudio(studioId, req.auth!.id))) throw Errors.notOwner();
    const updated = await changeMemberRole(studioId, param(req, "memberId"), req.body.role);
    res.json(updated);
  }),
);

studioRouter.post(
  "/:id/members/:memberId/resend-invite",
  requireAuth,
  asyncHandler(async (req, res) => {
    const studioId = param(req, "id");
    if (!(await canManageStudio(studioId, req.auth!.id))) throw Errors.notOwner();
    const member = await resendInvite(studioId, param(req, "memberId"));
    res.json({ sent: true, to: member.email });
  }),
);

const transferSchema = z.object({ toMemberId: z.string().uuid() });

// The founder specifically, not any manager — see
// services/studios/membership.ts#transferOwnership for why.
studioRouter.post(
  "/:id/transfer",
  requireAuth,
  validate(transferSchema),
  asyncHandler(async (req, res) => {
    const studioId = param(req, "id");
    if (!(await isStudioOwner(studioId, req.auth!.id))) {
      throw Errors.notOwner("Only the studio's founder can transfer it.");
    }
    const { studio, newOwner } = await transferOwnership(studioId, req.body.toMemberId);
    res.json({ studio, newOwner: { id: newOwner.id, handle: newOwner.handle } });
  }),
);

// Owner and members. A team that cannot see its own takings is not a team, and
// a collaborator credited on the games has more reason to look than anyone.
// Nobody outside the studio sees any of it.
studioRouter.get(
  "/:id/earnings",
  requireAuth,
  asyncHandler(async (req, res) => {
    const studioId = param(req, "id");
    const studio = await db.query.studios.findFirst({ where: eq(studios.id, studioId) });
    if (!studio) throw Errors.notFound("Studio");

    const allowed =
      studio.ownerUserId === req.auth!.id || (await isStudioMember(studio.id, req.auth!.id));
    if (!allowed) throw Errors.notOwner("Only this studio's team can see its earnings.");

    const report = await studioEarnings(studio.id);
    if (!report) throw Errors.notFound("Studio");
    res.json(report);
  }),
);

export default studioRouter;
