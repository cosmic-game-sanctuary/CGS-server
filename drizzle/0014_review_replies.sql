ALTER TYPE "public"."notification_type" ADD VALUE 'review_reply';--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "developer_reply" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "developer_reply_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "developer_reply_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_developer_reply_by_user_id_users_id_fk" FOREIGN KEY ("developer_reply_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;