import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { optionalAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { Errors } from "../lib/errors.js";
import { param } from "../lib/params.js";
import { isReservedHandle, normaliseHandle } from "../lib/handle.js";
import { publicProfile } from "../services/users/profile.js";

/**
 * Public identity. One page per person, addressed by handle.
 *
 * Nothing here needs a signed-in caller, and nothing here returns an email
 * address. `optionalAuth` is present only so a person looking at their own
 * page sees it as theirs — and so a private library is still visible to its
 * owner.
 */
const userRouter = Router({ caseSensitive: true, strict: true });

// Before /:handle, or "handle-availability" would be read as somebody's name.
userRouter.get(
  "/handle-availability",
  validate(z.object({ handle: z.string().min(1).max(40) }), "query"),
  asyncHandler(async (req, res) => {
    const { handle } = req.query as unknown as { handle: string };
    const normalised = normaliseHandle(handle);

    // Three separate answers on purpose. "Taken" and "not allowed" and "that
    // isn't a usable handle at all" need different things said about them, and
    // a single `available: false` would make all three look like bad luck.
    if (!normalised) {
      res.json({ handle, normalised: null, available: false, reason: "unusable" });
      return;
    }
    if (isReservedHandle(normalised)) {
      res.json({ handle, normalised, available: false, reason: "reserved" });
      return;
    }
    const taken = await db.query.users.findFirst({
      where: eq(users.handle, normalised),
      columns: { id: true },
    });
    res.json({
      handle,
      // Returned because it may differ from what was typed — "Kai Saha" becomes
      // "kaisaha" — and the person claiming it should see that before they do.
      normalised,
      available: !taken,
      reason: taken ? "taken" : null,
    });
  }),
);

userRouter.get(
  "/:handle",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const profile = await publicProfile(param(req, "handle"), req.auth?.id);
    if (!profile) throw Errors.notFound("Profile");
    res.json(profile);
  }),
);

export default userRouter;
