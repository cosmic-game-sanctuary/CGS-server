ALTER TABLE "listener_state" ALTER COLUMN "topic_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "listener_state" ADD COLUMN "last_block" bigint;