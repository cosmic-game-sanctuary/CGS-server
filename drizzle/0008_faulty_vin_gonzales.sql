ALTER TYPE "public"."agent_status" ADD VALUE 'buying' BEFORE 'fired';--> statement-breakpoint
ALTER TYPE "public"."agent_status" ADD VALUE 'underfunded' BEFORE 'fired';--> statement-breakpoint
ALTER TYPE "public"."agent_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'agent_underfunded';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'agent_cancelled';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'agent_failed';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'agent_target_gone';--> statement-breakpoint
CREATE TABLE "listener_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"topic_id" text NOT NULL,
	"last_consensus_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wishlist_agents" ADD COLUMN "pending_price_units" bigint;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ADD COLUMN "underfunded_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ADD COLUMN "last_balance_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ADD COLUMN "notified_shortfall_units" bigint;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ADD COLUMN "underfunded_notified_at" timestamp with time zone;--> statement-breakpoint
-- The listener's join: every incoming price looks up agents by game and
-- trigger price, so this is the difference between an index and a scan.
-- Does not reference any specific enum *value*, only the column's type, so
-- it is safe to create here alongside the ALTER TYPE ADD VALUE statements
-- above. The other index this file used to create here — a partial index
-- filtering on specific status values — is not, and moved to
-- 0008a_wishlist_agents_live_index.sql: Postgres refuses to use an enum
-- value added by ALTER TYPE ADD VALUE until that transaction commits, and
-- this file's statements are one transaction. See CLAUDE.md's gotchas table.
CREATE INDEX IF NOT EXISTS "wishlist_agents_target_lookup"
  ON "wishlist_agents" ("target_game_id", "status", "trigger_price_units");
