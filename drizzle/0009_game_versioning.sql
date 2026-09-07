ALTER TYPE "public"."notification_type" ADD VALUE 'build_updated';--> statement-breakpoint
CREATE TABLE "game_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"label" text,
	"notes" text,
	"build_cid" text NOT NULL,
	"build_zip_cid" text,
	"build_size_kb" integer,
	"hcs_tx_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_price_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"from_units" bigint NOT NULL,
	"to_units" bigint NOT NULL,
	"asset" text NOT NULL,
	"changed_by_user_id" uuid,
	"hcs_tx_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "delisted_by" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "build_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "game_builds" ADD CONSTRAINT "game_builds_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_price_changes" ADD CONSTRAINT "game_price_changes_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_price_changes" ADD CONSTRAINT "game_price_changes_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_builds_game_version_idx" ON "game_builds" USING btree ("game_id","version");