import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  jsonb,
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
  wallet: text("wallet").notNull(),
  handle: text("handle").notNull(),
  role: text("role").notNull(),
  pct: integer("pct").notNull(),
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
