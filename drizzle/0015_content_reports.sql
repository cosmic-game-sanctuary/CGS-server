CREATE TYPE "public"."content_report_action" AS ENUM('none', 'removed');--> statement-breakpoint
CREATE TYPE "public"."content_report_target" AS ENUM('review', 'comment');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'report_resolved';--> statement-breakpoint
CREATE TABLE "content_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "content_report_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"action" "content_report_action" DEFAULT 'none' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;