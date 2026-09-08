import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// money is always smallest-units integers (USDC has 6 decimals, HBAR has 8).
// never a float, anywhere in this file.

export const studioRoleEnum = pgEnum("studio_role", ["owner", "member"]);
export const gameStatusEnum = pgEnum("game_status", [
  "draft",
  "published",
  "delisted",
  "removed",
]);
export const mediaKindEnum = pgEnum("media_kind", ["image", "video"]);
export const mintStatusEnum = pgEnum("mint_status", [
  "pending",
  "confirmed",
  "failed",
]);
// Rewritten for the 1:N redesign (wishlist-agent-spec.md) — no live rows
// existed under the old 1:1 shape, so this is a clean replacement rather than
// an addition. "fired" is gone: an agent with several wants does not end after
// one purchase, it keeps watching the rest.
export const agentStatusEnum = pgEnum("agent_status", [
  "draft",
  "funded",
  "watching",
  // A momentary claim, not a resting state. Exactly one caller can move a row
  // into it, which is what makes a double purchase impossible when a message
  // is replayed or two processes both see the same price drop.
  "buying",
  "cancelled",
  // Hit its expiry with wants still open. Distinct from `cancelled` only in
  // who ended it; both return the balance the same way.
  "expired",
  "failed",
]);
export const agentModeEnum = pgEnum("agent_mode", ["autonomous", "ask_first"]);
export const agentTimeoutActionEnum = pgEnum("agent_timeout_action", ["buy", "skip"]);
// What one round of evaluating an agent against a price event produced. Kept
// even for a plain deterministic buy (no model involved) so the audit trail
// has one shape from the start — Stage 19 only adds `reasoning` to it, it
// does not introduce the table.
export const agentDecisionKindEnum = pgEnum("agent_decision_kind", [
  "bought",
  "held",
  "declined",
  "asked",
]);
export const reportActionEnum = pgEnum("report_action", [
  "none",
  "delisted",
  "removed_from_storage",
]);
// "partial" is the honest answer when some of a split paid out and some is
// held for a collaborator who hasn't claimed their invite. It is not a
// failure — the money that could move, moved.
export const splitStatusEnum = pgEnum("split_status", [
  "pending",
  "distributed",
  "partial",
  "failed",
]);
export const payoutStatusEnum = pgEnum("payout_status", ["held", "settled", "failed"]);
export const notificationTypeEnum = pgEnum("notification_type", [
  "sale",
  "invite",
  "agent_fired",
  "published",
  // A share that couldn't be paid at settlement, and the moment it finally
  // was. Held money used to be silent on both ends: the person owed it never
  // learned it existed, and the studio never learned a teammate was unpaid.
  "payout_held",
  "payout_settled",
  "agent_underfunded",
  "agent_cancelled",
  "agent_failed",
  // A purchase the agent made on its own — the 1:N replacement for
  // `agent_fired`, which named a thing that could only ever happen once.
  // `agent_fired` stays in this type (Postgres cannot drop an enum value) but
  // nothing writes it any more.
  "agent_purchased",
  // Its expiry passed. The balance was returned; this is what tells the
  // person that happened and why.
  "agent_expired",
  // Ask-first mode found real contention and wants an answer before deciding.
  "agent_asked",
  // The game an agent is watching stopped being for sale. It cannot fire now,
  // but we still don't close it — the buyer decides that, and their money is
  // sitting in it.
  "agent_target_gone",
  // A game you own shipped a patch. The argument for owning a key rather than
  // a download is that the key keeps being worth something; this is the moment
  // that becomes visible.
  "build_updated",
  // The reason to keep a wishlist at all: something on it got cheaper.
  "price_drop",
  // A studio replied to your review.
  "review_reply",
  // A report you filed — on a game, a review, or a comment — was resolved.
  // The one message that closes the loop: before this, a reporter had no way
  // to learn whether anything happened after they reported something.
  "report_resolved",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  privyDid: text("privy_did").notNull().unique(),
  email: text("email").notNull(),
  evmAddress: text("evm_address").notNull(),
  // The public name. Everything a person did — a review, a comment, a credit
  // on a game's splits — used to display as a truncated address, which made
  // every author on the site look like the same anonymous stranger and gave
  // nobody a page to link to. Lowercased and unique, because it is an address:
  // /u/:handle. Assigned at first sign-in from the email's local part, and
  // changeable afterwards.
  //
  // Not the same thing as `studioMembers.handle`, which is the name on one
  // game's credits and can differ per studio on purpose.
  handle: text("handle"),
  // What is actually printed. A handle has to be URL-safe; a name does not.
  displayName: text("display_name"),
  bio: text("bio"),
  avatarCid: text("avatar_cid"),
  // Whether strangers see what this person owns. Default open, because a
  // storefront where nobody can see what anyone plays has no social surface at
  // all — but it is a real choice and some people will want it off.
  libraryPublic: boolean("library_public").notNull().default(true),
  // Privy's internal wallet id + compressed public key — both needed to sign
  // a payment on this user's behalf via secp256k1_sign. Neither is secret;
  // Privy still holds the private key.
  privyWalletId: text("privy_wallet_id").notNull(),
  // Null until this wallet has actually signed something. Deriving it costs a
  // real signing call, and the server can only sign with a user's embedded
  // wallet once that user has delegated it — so doing it at sign-in made
  // logging in depend on an authority login doesn't need, and broke every
  // authenticated request for anyone who hadn't delegated.
  // See services/users/repo.ts#ensureUserPublicKey.
  publicKeyHex: text("public_key_hex"),
  // null until the address completes its own first outgoing transaction and
  // the account resolves on the mirror node. see services/hedera/mirror.ts.
  hederaAccountId: text("hedera_account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("users_handle_idx").on(table.handle)]);

export const studios = pgTable("studios", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  bio: text("bio"),
  ensSubname: text("ens_subname"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const studioMembers = pgTable("studio_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  studioId: uuid("studio_id").notNull().references(() => studios.id),
  // null until the invite is accepted — this is what makes jam-team splits work
  // without everyone needing a wallet up front.
  userId: uuid("user_id").references(() => users.id),
  email: text("email").notNull(),
  handle: text("handle").notNull(),
  role: studioRoleEnum("role").notNull().default("member"),
  invitedAt: timestamp("invited_at", { withTimezone: true }).defaultNow().notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  // The org chart, not the credit ledger. Someone who leaves or is removed
  // stops being active here, but every `splits` row naming them — on every
  // game they helped make, published or not — is untouched: that credit and
  // any pending payout are permanent, the same immutability the splits table
  // already promises everywhere else. This is what makes "remove a member"
  // possible at all without contradicting that promise. See
  // services/studios/membership.ts.
  active: boolean("active").notNull().default(true),
});

export const games = pgTable("games", {
  id: uuid("id").primaryKey().defaultRandom(),
  studioId: uuid("studio_id").notNull().references(() => studios.id),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  tagline: text("tagline").notNull().default(""),
  description: text("description").notNull().default(""),
  tags: text("tags").array().notNull().default([]),
  coverCid: text("cover_cid"),
  coverSeed: integer("cover_seed").notNull(),
  buildCid: text("build_cid"),
  // The same build pinned a second way, as the original zip rather than the
  // unpacked directory. `build_cid` is the provenance answer and what a person
  // verifies; this is the delivery answer. Pinata's public gateway refuses to
  // serve HTML, so a directory CID (which resolves to index.html) is a 403,
  // while application/zip is served normally — checked, not assumed. Without
  // this a build only exists on the disk of whichever machine pinned it.
  buildZipCid: text("build_zip_cid"),
  buildSizeKb: integer("build_size_kb"),
  priceUnits: bigint("price_units", { mode: "number" }).notNull().default(0),
  priceAsset: text("price_asset").notNull(),
  status: gameStatusEnum("status").notNull().default("draft"),
  // Who took it out of the catalog, when something did. "developer" is a
  // choice and can be undone by the person who made it; "moderation" is not
  // theirs to undo. Both land in the same `delisted` status because the effect
  // on a buyer is identical — their key still works either way — but a relist
  // endpoint has to be able to tell them apart.
  delistedBy: text("delisted_by"),
  htsTokenId: text("hts_token_id"),
  // The build currently being served. Every version ever published is a row in
  // `gameBuilds`; the columns above always mirror whichever one is current, so
  // nothing that serves a build had to learn about versions.
  buildVersion: integer("build_version").notNull().default(1),
  // The highest wishlist milestone already announced on the public topic, so a
  // game crossing 25 says so once rather than on every save afterwards.
  demandMilestone: integer("demand_milestone").notNull().default(0),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  // Distinct from createdAt and from publishedAt: the last time anything about
  // this listing changed — a price, a description, a new build. It is what a
  // "recently updated" shelf sorts on.
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const gameMedia = pgTable("game_media", {
  id: uuid("id").primaryKey().defaultRandom(),
  gameId: uuid("game_id").notNull().references(() => games.id),
  kind: mediaKindEnum("kind").notNull(),
  cid: text("cid").notNull(),
  position: integer("position").notNull().default(0),
});

// Every build ever published for a game, oldest first by `version`.
//
// A game used to have exactly one build, forever. Games get patched — the
// build this was tested against was literally named "v18" — and with no
// version concept the only way to ship a fix was to publish a second game,
// which splits its reviews, its sales and its owners across two listings.
// Buyers hold a key to a game rather than a copy of one file, so the patch is
// theirs; that is the entire argument for a key over a download.
//
// The rows here are append-only and each carries its own CID, so the history
// of what a game *was* stays verifiable even after it changes. `games` mirrors
// whichever row is current, which is why nothing that serves a build had to
// learn about this table.
export const gameBuilds = pgTable(
  "game_builds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id").notNull().references(() => games.id),
    version: integer("version").notNull(),
    // What the developer calls it — "v18", "1.0.2", "post-jam". Free text
    // because a version number that we invent is not the one in their notes.
    label: text("label"),
    notes: text("notes"),
    buildCid: text("build_cid").notNull(),
    buildZipCid: text("build_zip_cid"),
    buildSizeKb: integer("build_size_kb"),
    // The HCS message announcing this version. Null for versions recorded
    // before the game was published, which were never announced.
    hcsTxId: text("hcs_tx_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("game_builds_game_version_idx").on(table.gameId, table.version)],
);

export const promotionStatusEnum = pgEnum("promotion_status", [
  "scheduled",
  "active",
  "ended",
  "cancelled",
]);

// A sale: a price, a start, an end, and an automatic revert.
//
// Before this a "sale" was a developer changing a number and remembering to
// change it back, which is why sales barely happened. Two things follow from
// making it a real record:
//
//   The revert is ours to do, not theirs to remember. `ends_at` passing is what
//   restores `base_price_units`, and both the start and the end go on the
//   public listings topic like any other price change.
//
//   **`ends_at` is published**, which is what makes deadline reasoning possible
//   for anything reading the topic. An agent can only safely wait for a better
//   price if it knows when waiting stops being an option — see
//   ../../docs/wishlist-agent-spec.md §4.
export const gamePromotions = pgTable("game_promotions", {
  id: uuid("id").primaryKey().defaultRandom(),
  gameId: uuid("game_id").notNull().references(() => games.id),
  salePriceUnits: bigint("sale_price_units", { mode: "number" }).notNull(),
  // Captured when the promotion is created, and what the price returns to when
  // it ends. Stored rather than re-read at revert time because the listing
  // price *is* the sale price while it runs, so by then the original is gone.
  basePriceUnits: bigint("base_price_units", { mode: "number" }).notNull(),
  asset: text("asset").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  status: promotionStatusEnum("status").notNull().default("scheduled"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  // Both ends of a sale are public events, so both get a transaction id.
  hcsStartTxId: text("hcs_start_tx_id"),
  hcsEndTxId: text("hcs_end_tx_id"),
  // A sale that ended and was brought back is a *new* row pointing at the old
  // one, never an edit of it — so the public history stays truthful about what
  // was actually on offer when. Deliberately not a foreign key: it references
  // this same table, and drizzle needs a type annotation dance for self
  // references that buys nothing here.
  supersedesId: uuid("supersedes_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// One row per price change, each carrying the HCS message that announced it.
//
// Every storefront could show a price history and none of them can make it
// credible, because they all own the database it lives in. Ours is a local
// index of messages already on a public topic: `hcsTxId` is checkable on the
// mirror node by someone who does not trust this table at all. That is the
// only reason it is worth storing separately from `games.price_units`.
export const gamePriceChanges = pgTable("game_price_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  gameId: uuid("game_id").notNull().references(() => games.id),
  fromUnits: bigint("from_units", { mode: "number" }).notNull(),
  toUnits: bigint("to_units", { mode: "number" }).notNull(),
  asset: text("asset").notNull(),
  changedByUserId: uuid("changed_by_user_id").references(() => users.id),
  hcsTxId: text("hcs_tx_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// immutable once the game is published. no edit endpoint touches this table
// after that point, on purpose.
export const splits = pgTable("splits", {
  id: uuid("id").primaryKey().defaultRandom(),
  gameId: uuid("game_id").notNull().references(() => games.id),
  userId: uuid("user_id").references(() => users.id),
  // Null when this share belongs to someone who hasn't signed in yet. The
  // splits editor's whole reason to exist is adding a collaborator by email,
  // and a person who has never opened CGS has no address to name — so the
  // share is held (see pendingPayouts) until they claim it, rather than the
  // game being unpublishable. Backfilled when they accept their invite.
  wallet: text("wallet"),
  // Who the share is for when there's no wallet yet. This is also the invite:
  // /invite/:id is a studio_members row id.
  studioMemberId: uuid("studio_member_id").references(() => studioMembers.id),
  handle: text("handle").notNull(),
  role: text("role").notNull(),
  pct: integer("pct").notNull(),
});

// A share that was owed but couldn't be paid at settlement, because the person
// it belongs to has no Hedera account yet.
//
// Before this, one unresolvable recipient threw and failed the entire
// distribution — nobody on the split got paid, which is the opposite of the
// promise the product makes out loud ("anyone invited by email is on the
// splits from the first sale whether or not they've accepted"). Now everyone
// resolvable is paid in one transaction and the rest land here, to be settled
// the moment the person claims their invite.
export const pendingPayouts = pgTable("pending_payouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  saleId: uuid("sale_id").notNull().references(() => sales.id),
  gameId: uuid("game_id").notNull().references(() => games.id),
  splitId: uuid("split_id").notNull().references(() => splits.id),
  studioMemberId: uuid("studio_member_id").references(() => studioMembers.id),
  amountUnits: bigint("amount_units", { mode: "number" }).notNull(),
  asset: text("asset").notNull(),
  status: payoutStatusEnum("status").notNull().default("held"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  settlementTxId: text("settlement_tx_id"),
});

// a cache of on-chain truth, never the source of it. anything that gates
// access checks the mirror node, not this table.
export const gameKeys = pgTable("game_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenId: text("token_id").notNull(),
  serial: integer("serial"),
  gameId: uuid("game_id").notNull().references(() => games.id),
  ownerAccountId: text("owner_account_id").notNull(),
  mintStatus: mintStatusEnum("mint_status").notNull().default("pending"),
  txId: text("tx_id"),
  mintedAt: timestamp("minted_at", { withTimezone: true }),
});

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  gameId: uuid("game_id").notNull().references(() => games.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  rating: integer("rating").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  // The developer's own voice on their own page. One reply per review, from
  // the studio rather than from a specific person — whoever on the team wrote
  // it, it speaks for the studio the way the game's own listing does. Posting
  // again overwrites it; there is no thread.
  developerReply: text("developer_reply"),
  developerReplyAt: timestamp("developer_reply_at", { withTimezone: true }),
  // Who actually wrote it, kept for accountability even though it displays as
  // the studio. Not a foreign key the UI needs to resolve — see
  // authorSummaries if it ever does.
  developerReplyByUserId: uuid("developer_reply_by_user_id").references(() => users.id),
});

// One per person — the 1:N redesign. A "want" (which game, up to what price)
// lives on the wishlist row it upgrades (see `wishlistItems.agentMaxUnits`
// below), not here. This table is the wallet, the identity, and the settings
// that apply across every want at once.
export const wishlistAgents = pgTable("wishlist_agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  buyerUserId: uuid("buyer_user_id").notNull().unique().references(() => users.id),
  // the agent's wallet. always a separate wallet from the buyer's own — never
  // the same one. its balance is the spending cap, nothing else, and it is
  // never mirrored into a column here — see me.routes.ts's own balance field
  // for why a cached balance is just a wrong balance waiting to happen.
  agentWalletId: text("agent_wallet_id").notNull(),
  agentEvmAddress: text("agent_evm_address").notNull(),
  // captured at wallet creation — needed to sign a payment with this
  // wallet later. Fetching it after the fact would hit the same
  // null-until-first-outgoing-tx gotcha the account id already has.
  agentPublicKeyHex: text("agent_public_key_hex").notNull(),
  agentAccountId: text("agent_account_id"),
  hcs14Aid: text("hcs14_aid"),
  status: agentStatusEnum("status").notNull().default("draft"),
  // Autonomous acts and tells you after. Ask-first sends the recommendation
  // and waits, but only when a human could plausibly answer before the sale
  // ends — see services/agent/decide.ts.
  mode: agentModeEnum("mode").notNull().default("autonomous"),
  // What happens if an ask-first question goes unanswered past its deadline.
  // Defaults to buying: the person funded a wallet in order to buy things,
  // and defaulting to inaction contradicts why they set it up.
  onTimeout: agentTimeoutActionEnum("on_timeout").notNull().default("buy"),
  // Null = watches indefinitely. When set and passed, the sweep cancels the
  // agent and returns its balance automatically — see agent/sweep.ts.
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // Optional human-readable identity, minted the same way a studio subname is
  // — same subregistry, same real on-chain availability check — so "my agent
  // is scout.cgs-sanctuary.eth" is something a person can actually have
  // instead of a raw EVM address. Entirely optional; an agent works the same
  // without one.
  ensLabel: text("ens_label"),
  ensTxHash: text("ens_tx_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// The audit trail: what the agent considered, what it chose, and why. Written
// even for a plain deterministic buy with no model involved — `reasoning` is
// null there — so the shape exists before Stage 19 needs it rather than being
// introduced alongside the model. This is what makes "the agent's thinking is
// inspectable" true rather than a claim.
export const agentDecisions = pgTable("agent_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => wishlistAgents.id),
  kind: agentDecisionKindEnum("kind").notNull(),
  consideredGameIds: uuid("considered_game_ids").array().notNull().default([]),
  chosenGameIds: uuid("chosen_game_ids").array().notNull().default([]),
  // Null for a deterministic decision (Shape A/B — no contention, nothing to
  // explain). Populated once contention actually requires a model (Stage 19).
  reasoning: text("reasoning"),
  inferenceCostUnits: bigint("inference_cost_units", { mode: "number" }),
  // Set only while a hold or an ask-first question has not yet resolved.
  decideBy: timestamp("decide_by", { withTimezone: true }),
  // Null while a `held`/`asked` row is still live. Set the moment it stops
  // being live — the person answered, `decideBy` passed and the sweep acted,
  // or a fresh price event superseded it before either happened (§4: "a
  // pending question expires if the world moves"). `bought`/`declined` rows
  // are resolved the instant they're written, same timestamp as `createdAt`.
  // The live pending decision for an agent, if it has one, is the most recent
  // row with `resolvedAt IS NULL`.
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Where the listener got to on the listings topic.
//
// One row. The cursor is shared rather than per agent because every agent
// watches the same topic: reading it once per agent made cost grow with the
// number of agents and hit the mirror node's rate limit at around 25 of them.
// A consensus timestamp rather than a sequence number, because that is what
// TopicMessageQuery.setStartTime() resumes from after a restart.
export const listenerState = pgTable("listener_state", {
  id: integer("id").primaryKey().default(1),
  topicId: text("topic_id").notNull(),
  lastConsensusAt: timestamp("last_consensus_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const moderationReports = pgTable("moderation_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  gameId: uuid("game_id").notNull().references(() => games.id),
  reporterUserId: uuid("reporter_user_id").references(() => users.id),
  reason: text("reason").notNull(),
  reportedAt: timestamp("reported_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  action: reportActionEnum("action").notNull().default("none"),
});

export const contentReportTargetEnum = pgEnum("content_report_target", ["review", "comment"]);
// Deliberately smaller than `report_action`: there is no "delisted" or
// "removed_from_storage" equivalent for a review or a comment, only whether it
// stayed or was taken down.
export const contentReportActionEnum = pgEnum("content_report_action", ["none", "removed"]);

// A report against a review or a comment — the two user-generated surfaces a
// game report can't cover, since delisting a whole game over one bad review is
// the wrong tool. `targetId` points at `reviews.id` or `comments.id` depending
// on `targetType`; it's not a foreign key because it names one of two tables,
// which Postgres has no way to express as a single constraint.
//
// Unlike a game report, **this never acts automatically.** A game report
// delists on submission because the downside of a false positive (briefly
// unlisted, easily restored) is small next to the downside of leaving up
// something that shouldn't be. That trade is upside down here: instantly
// hiding a review on a single report would hand any developer a one-click way
// to silence a negative-but-honest review of their own game. So a report here
// only queues for a human to look at — see services/moderation/contentReports.ts.
export const contentReports = pgTable("content_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetType: contentReportTargetEnum("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  reporterUserId: uuid("reporter_user_id").notNull().references(() => users.id),
  reason: text("reason").notNull(),
  reportedAt: timestamp("reported_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  action: contentReportActionEnum("action").notNull().default("none"),
});

// only the two sides the catalog query actually uses (`with: { studio: true }`)
// need declaring — drizzle's relational query API requires both ends defined.
export const gamesRelations = relations(games, ({ one }) => ({
  studio: one(studios, { fields: [games.studioId], references: [studios.id] }),
}));

export const studiosRelations = relations(studios, ({ many }) => ({
  games: many(games),
}));

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  type: notificationTypeEnum("type").notNull(),
  // shape depends on `type`; nothing here is queried on, only displayed.
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
});

// Stage 9: a real play, timed. Started when the player actually boots (after
// /download or /pay hands back a playUrl, never before), ended by an explicit
// call from the client. A session that never gets an end call — a closed tab,
// a crash — still counts once toward `plays` (see game.routes.ts#playsFor),
// it just never gets a duration, which is more honest than guessing one.
export const playSessions = pgTable("play_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  gameId: uuid("game_id").notNull().references(() => games.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  // only set alongside endedAt, and capped — see game.routes.ts#MAX_SESSION_SECONDS.
  durationSeconds: integer("duration_seconds"),
});

// The wishlist. One row per person per game, and adding a game twice is the
// same as adding it once.
//
// This started life as `likes` and the physical table still has that name — a
// rename would gain nothing at the cost of a migration drizzle-kit can only
// resolve through an interactive prompt. The concept is the one that changed:
// a "like" was approval with nothing downstream of it, and what the product
// was missing was *intent* — the thing Steam built its entire retention
// mechanic on and the thing that tells a developer demand exists before they
// discount. Same rows, given a purpose.
//
// No ownership gate, on purpose: saving a game you have not bought is the
// entire point, unlike a review, which is a verified-purchase signal.
export const wishlistItems = pgTable(
  "likes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id").notNull().references(() => games.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    // What it cost when they added it. This is what makes "down 40% since you
    // saved it" possible, and it has to be captured at the moment of adding —
    // there is no way to recover it afterwards for a game whose price has
    // since moved. Null for rows that predate this.
    priceUnitsWhenAdded: bigint("price_units_when_added", { mode: "number" }),
    priceAsset: text("price_asset"),
    // Per-row rather than per-person: someone may want telling about one game
    // and not about the eleven others they saved on a whim.
    notifyOnDrop: boolean("notify_on_drop").notNull().default(true),
    // Upgrades a plain wishlist row into a "want" the person's agent may act
    // on — the maximum price they'd pay for this one specific game. Null means
    // a plain wishlist entry with no agent involvement, which is the default
    // and the common case. This is what makes "the agent is the paid upgrade
    // of the free wishlist" literal: same row, one extra field, and
    // un-wishlisting the game removes the want along with it.
    agentMaxUnits: bigint("agent_max_units", { mode: "number" }),
    // In the person's own words — "only under $4", "for co-op", "notify me,
    // don't buy". Gives a future model something human to reason with without
    // us inventing a preference taxonomy.
    agentNote: text("agent_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("likes_game_user_idx").on(table.gameId, table.userId)],
);

/**
 * The old name, kept as an alias so nothing that already reads `likes` had to
 * change in the same commit that gave the table a purpose.
 */
export const likes = wishlistItems;

// Unrestricted discussion — the deliberate difference from `reviews`, which
// stay gated to verified owners and carry a rating. A comment carries neither;
// it's a normal storefront comment thread, not a verified-purchase signal.
export const comments = pgTable("comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  gameId: uuid("game_id").notNull().references(() => games.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
});

// A browser game's progress, kept somewhere that isn't one browser.
//
// Builds run sandboxed on their own origin, so whatever a game writes to
// localStorage or IndexedDB lives in *that browser on that machine*. Clear site
// data, switch laptop, open it on a phone: the save is gone. Steam solved this
// with Cloud Saves and it is table stakes for anything you expect people to
// come back to — for browser games it matters more, not less, because the
// storage is more fragile.
//
// The data is opaque to us. It is whatever the client dumped out of the game's
// own storage, and it is never parsed here; `checksum` is what lets the client
// prove it got back what it put in, and `version` is what lets two devices
// notice they disagree instead of one silently overwriting the other.
export const saveStates = pgTable(
  "save_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id").notNull().references(() => games.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    // Several, because "one save per game" is a rule about our storage and not
    // about how anyone actually plays.
    slot: integer("slot").notNull().default(0),
    label: text("label"),
    data: text("data").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    checksum: text("checksum").notNull(),
    // Which machine wrote it, as the person named it. Purely so a conflict can
    // be described in words someone recognises rather than as two timestamps.
    device: text("device"),
    // Bumped on every write. A client that sends the version it started from
    // gets a conflict instead of quietly clobbering a newer save.
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("save_states_game_user_slot_idx").on(table.gameId, table.userId, table.slot)],
);

// the audit trail Stage 4 asked for: one row per settled purchase, independent
// of whether the split that pays the dev team actually went out. Without this
// table a failed split had nowhere to be recorded or retried from — it just
// logged an error and moved on.
export const sales = pgTable("sales", {
  id: uuid("id").primaryKey().defaultRandom(),
  gameId: uuid("game_id").notNull().references(() => games.id),
  buyerAccountId: text("buyer_account_id").notNull(),
  priceUnits: bigint("price_units", { mode: "number" }).notNull(),
  priceAsset: text("price_asset").notNull(),
  settlementTxId: text("settlement_tx_id").notNull(),
  hcsSaleTxId: text("hcs_sale_tx_id"),
  splitStatus: splitStatusEnum("split_status").notNull().default("pending"),
  splitError: text("split_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
