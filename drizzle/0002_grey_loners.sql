ALTER TABLE "users" ADD COLUMN "privy_wallet_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "public_key_hex" text NOT NULL;--> statement-breakpoint
ALTER TABLE "wishlist_agents" ADD COLUMN "agent_public_key_hex" text NOT NULL;