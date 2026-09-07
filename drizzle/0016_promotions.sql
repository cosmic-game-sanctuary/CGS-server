CREATE TYPE "public"."promotion_status" AS ENUM('scheduled', 'active', 'ended', 'cancelled');--> statement-breakpoint
CREATE TABLE "game_promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"sale_price_units" bigint NOT NULL,
	"base_price_units" bigint NOT NULL,
	"asset" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "promotion_status" DEFAULT 'scheduled' NOT NULL,
	"created_by_user_id" uuid,
	"hcs_start_tx_id" text,
	"hcs_end_tx_id" text,
	"supersedes_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_promotions" ADD CONSTRAINT "game_promotions_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_promotions" ADD CONSTRAINT "game_promotions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;