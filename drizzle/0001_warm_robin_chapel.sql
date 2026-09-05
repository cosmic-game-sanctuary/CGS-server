CREATE TYPE "public"."split_status" AS ENUM('pending', 'distributed', 'failed');--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"buyer_account_id" text NOT NULL,
	"price_units" bigint NOT NULL,
	"price_asset" text NOT NULL,
	"settlement_tx_id" text NOT NULL,
	"hcs_sale_tx_id" text,
	"split_status" "split_status" DEFAULT 'pending' NOT NULL,
	"split_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;