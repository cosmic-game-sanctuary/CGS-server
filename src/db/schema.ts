import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  bigint,
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
export const agentStatusEnum = pgEnum("agent_status", [
  "draft",
  "funded",
  "watching",
  "fired",
  "failed",
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
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  privyDid: text("privy_did").notNull().unique(),
  email: text("email").notNull(),
  evmAddress: text("evm_address").notNull(),
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
});

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
  buildSizeKb: integer("build_size_kb"),
  priceUnits: bigint("price_units", { mode: "number" }).notNull().default(0),
  priceAsset: text("price_asset").notNull(),
  status: gameStatusEnum("status").notNull().default("draft"),
  htsTokenId: text("hts_token_id"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const gameMedia = pgTable("game_media", {
  id: uuid("id").primaryKey().defaultRandom(),
  gameId: uuid("game_id").notNull().references(() => games.id),
  kind: mediaKindEnum("kind").notNull(),
  cid: text("cid").notNull(),
  position: integer("position").notNull().default(0),
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
});

export const wishlistAgents = pgTable("wishlist_agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  buyerUserId: uuid("buyer_user_id").notNull().references(() => users.id),
  // the agent's wallet. always a separate wallet from the buyer's own — never
  // the same one. its balance is the spending cap, nothing else.
  agentWalletId: text("agent_wallet_id").notNull(),
  agentEvmAddress: text("agent_evm_address").notNull(),
  // captured at wallet creation — needed to sign a payment with this
  // wallet later. Fetching it after the fact would hit the same
  // null-until-first-outgoing-tx gotcha the account id already has.
  agentPublicKeyHex: text("agent_public_key_hex").notNull(),
  agentAccountId: text("agent_account_id"),
  targetGameId: uuid("target_game_id").notNull().references(() => games.id),
  triggerPriceUnits: bigint("trigger_price_units", { mode: "number" }).notNull(),
  hcs14Aid: text("hcs14_aid"),
  status: agentStatusEnum("status").notNull().default("draft"),
  // persisted cursor so the watcher can restart without re-reading the whole
  // topic or missing a message.
  lastSeenSequence: integer("last_seen_sequence").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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

// A per-person toggle, not a count with history — liking again just unlikes.
// Deliberately no ownership gate: favoriting a game you haven't bought yet is
// normal in every real storefront (Steam wishlists, itch.io favorites).
export const likes = pgTable(
  "likes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id").notNull().references(() => games.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("likes_game_user_idx").on(table.gameId, table.userId)],
);

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
