CREATE TYPE "public"."payout_status" AS ENUM('held', 'settled', 'failed');--> statement-breakpoint
ALTER TYPE "public"."split_status" ADD VALUE 'partial' BEFORE 'failed';--> statement-breakpoint
CREATE TABLE "pending_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"split_id" uuid NOT NULL,
	"studio_member_id" uuid,
	"amount_units" bigint NOT NULL,
	"asset" text NOT NULL,
	"status" "payout_status" DEFAULT 'held' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"settlement_tx_id" text
);
--> statement-breakpoint
ALTER TABLE "splits" ALTER COLUMN "wallet" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "splits" ADD COLUMN "studio_member_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_payouts" ADD CONSTRAINT "pending_payouts_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_payouts" ADD CONSTRAINT "pending_payouts_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_payouts" ADD CONSTRAINT "pending_payouts_split_id_splits_id_fk" FOREIGN KEY ("split_id") REFERENCES "public"."splits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_payouts" ADD CONSTRAINT "pending_payouts_studio_member_id_studio_members_id_fk" FOREIGN KEY ("studio_member_id") REFERENCES "public"."studio_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splits" ADD CONSTRAINT "splits_studio_member_id_studio_members_id_fk" FOREIGN KEY ("studio_member_id") REFERENCES "public"."studio_members"("id") ON DELETE no action ON UPDATE no action;