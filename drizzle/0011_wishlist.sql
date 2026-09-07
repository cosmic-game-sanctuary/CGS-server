ALTER TYPE "public"."notification_type" ADD VALUE 'price_drop';--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "demand_milestone" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "likes" ADD COLUMN "price_units_when_added" bigint;--> statement-breakpoint
ALTER TABLE "likes" ADD COLUMN "price_asset" text;--> statement-breakpoint
ALTER TABLE "likes" ADD COLUMN "notify_on_drop" boolean DEFAULT true NOT NULL;