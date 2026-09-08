CREATE TYPE "public"."agent_decision_kind" AS ENUM('bought', 'held', 'declined', 'asked');--> statement-breakpoint
CREATE TYPE "public"."agent_mode" AS ENUM('autonomous', 'ask_first');--> statement-breakpoint
CREATE TYPE "public"."agent_timeout_action" AS ENUM('buy', 'skip');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'agent_purchased' BEFORE 'agent_target_gone';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'agent_expired' BEFORE 'agent_target_gone';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'agent_asked' BEFORE 'agent_target_gone';--> statement-breakpoint
CREATE TABLE "agent_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" "agent_decision_kind" NOT NULL,
	"considered_game_ids" uuid[] DEFAULT '{}' NOT NULL,
	"chosen_game_ids" uuid[] DEFAULT '{}' NOT NULL,
	"reasoning" text,
	"inference_cost_units" bigint,
	"decide_by" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wishlist_agents" DROP CONSTRAINT "wishlist_agents_target_game_id_games_id_fk";
--> statement-breakpoint
ALTER TABLE "wishlist_agents" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ALTER COLUMN "status" SET DEFAULT 'draft'::text;--> statement-breakpoint
DROP TYPE "public"."agent_status";--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('draft', 'funded', 'watching', 'buying', 'cancelled', 'expired', 'failed');--> statement-breakpoint
ALTER TABLE "wishlist_agents" ALTER COLUMN "status" SET DEFAULT 'draft'::"public"."agent_status";--> statement-breakpoint
ALTER TABLE "wishlist_agents" ALTER COLUMN "status" SET DATA TYPE "public"."agent_status" USING "status"::"public"."agent_status";--> statement-breakpoint
ALTER TABLE "wishlist_agents" ALTER COLUMN "target_game_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ALTER COLUMN "trigger_price_units" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ALTER COLUMN "last_seen_sequence" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ALTER COLUMN "last_seen_sequence" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "likes" ADD COLUMN "agent_max_units" bigint;--> statement-breakpoint
ALTER TABLE "likes" ADD COLUMN "agent_note" text;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ADD COLUMN "mode" "agent_mode" DEFAULT 'autonomous' NOT NULL;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ADD COLUMN "on_timeout" "agent_timeout_action" DEFAULT 'buy' NOT NULL;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ADD COLUMN "ens_label" text;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ADD COLUMN "ens_tx_hash" text;--> statement-breakpoint
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_agent_id_wishlist_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."wishlist_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ADD CONSTRAINT "wishlist_agents_buyer_user_id_unique" UNIQUE("buyer_user_id");