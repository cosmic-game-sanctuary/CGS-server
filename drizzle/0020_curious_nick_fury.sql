CREATE TYPE "public"."sale_kind" AS ENUM('purchase', 'trial_chunk');--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "trial_chunk_price_units" bigint;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "trial_chunk_minutes" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "trial_max_chunks" integer;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "kind" "sale_kind" DEFAULT 'purchase' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "credit_applied_units" bigint DEFAULT 0 NOT NULL;