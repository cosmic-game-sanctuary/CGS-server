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
-- One live agent per person per game. Partial, so cancelling or firing frees
-- the buyer to set a new watch on the same game later.
CREATE UNIQUE INDEX IF NOT EXISTS "wishlist_agents_one_live_per_game"
  ON "wishlist_agents" ("buyer_user_id", "target_game_id")
  WHERE "status" IN ('draft','funded','watching','buying','underfunded');
--> statement-breakpoint
-- The listener's join: every incoming price looks up agents by game and
-- trigger price, so this is the difference between an index and a scan.
CREATE INDEX IF NOT EXISTS "wishlist_agents_target_lookup"
  ON "wishlist_agents" ("target_game_id", "status", "trigger_price_units");
